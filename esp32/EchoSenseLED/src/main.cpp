/*
  EchoSenseLED — ESP32 BLE peripheral that receives EchoSense classification
  results from the AbleMind web app (Web Bluetooth, no native app needed)
  and drives two discrete LEDs as a wearable proximity/hazard indicator.

  The phone does all sensing + AI inference (unchanged) — this board is a
  pure output device: it does not sense anything itself.

  Wiring:
    YELLOW LED  anode -> 220-330ohm resistor -> GPIO 5  | cathode -> GND
    RED LED     anode -> 220-330ohm resistor -> GPIO 18 | cathode -> GND
    MAX3010x pulse sensor (I2C): VIN -> 3.3V | GND -> GND
                                  SDA -> GPIO 21 | SCL -> GPIO 22

  MAX3010x pulse sensor: this board reads the user's heart rate directly
  (independent of the phone) and drives the SOS LED pattern locally the
  moment BPM stays at/above PULSE_SOS_BPM for PULSE_SOS_SUSTAIN_MS — no
  phone/BLE connection required for this specific alert, so it still works
  as a physical panic signal even if the app or Bluetooth link is down.

  Protocol (phone -> board, write): "<classCode>,<distanceMeters>"
    classCode: W=wall  P=person  D=doorway  S=stairs  N=none  V=hard-stop  X=SOS
    e.g. "W,1.20"  or  "N,0.00"

  Protocol (board -> phone, notify on PULSE_CHARACTERISTIC_UUID): "<bpm>,<sosActive 0|1>"
    Sent ~2x/second whenever a phone is connected, so the app can show live
    BPM and fire its own full SOS flow (siren, location, WhatsApp) — not just
    the board's local LED pattern — the moment sosActive flips to 1.

  V (hard-stop) is a fused signal: the phone sends it whenever EITHER the
  sonar classifier's own proximity read OR the camera vision model flags an
  immediate hazard (very close obstacle, stairs, curb, moving obstacle,
  etc.). It takes priority over whichever single-sensor class the sonar
  classifier would otherwise be reporting.

  X (SOS) is sent once when the user triggers the emergency SOS control in
  the app (press-and-hold or a deliberate shake gesture) and holds until the
  phone sends a new code on cancel. It's the most urgent, most visually
  distinct pattern of all — meant to draw attention from anyone nearby.
*/

#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <esp_bt.h>
#include "soc/soc.h"
#include "soc/rtc_cntl_reg.h"
#include <Wire.h>
#include <MAX30105.h>
#include <heartRate.h>

#define YELLOW_PIN 5
#define RED_PIN 18

// Same UUIDs as the web app's src/lib/ble.ts — keep in sync if you change them.
#define SERVICE_UUID              "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define CHARACTERISTIC_UUID       "beb5483e-36e1-4688-b7f5-ea07361b26a8"
#define PULSE_CHARACTERISTIC_UUID "c1a9a3e2-2b0a-4f7a-9c2e-6f6a1b6e5d3a"

#define PULSE_NOTIFY_INTERVAL_MS 500

#define NEAR_THRESHOLD_M 1.0

// PWM duty for "on" (0-255) instead of a full digitalWrite HIGH. Laptop USB
// ports often can't supply enough current for two LEDs at full brightness at
// once — this cuts per-LED draw substantially (dimmer but still clearly
// visible) so the board doesn't brown out and reboot when both light up.
#define LED_DUTY 130

// Heart rate must be at/above this for PULSE_SOS_SUSTAIN_MS straight before
// it's treated as real distress and not a noisy single reading.
#define PULSE_SOS_BPM 120
#define PULSE_SOS_SUSTAIN_MS 3000
// Below this raw IR reading, treat it as "no finger/skin on the sensor" —
// avoids false triggers from ambient light noise when nothing is touching it.
#define PULSE_IR_PRESENCE_THRESHOLD 50000
// A single good "finger detected" read latches the touch LED feedback for
// this long — the I2C connection is flaky enough that a real touch often
// only registers for one sample before dropping out, so without a hold this
// feedback would flicker invisibly instead of being a clear signal.
#define FINGER_TOUCH_HOLD_MS 2000
#define RATE_SAMPLES 4

void setYellow(bool on) { analogWrite(YELLOW_PIN, on ? LED_DUTY : 0); }
void setRed(bool on) { analogWrite(RED_PIN, on ? LED_DUTY : 0); }

char classCode = 'N';
float distanceM = 0.0;
unsigned long lastBlinkMs = 0;
bool blinkState = false;

MAX30105 particleSensor;
bool pulseSensorPresent = false;
byte rateSpot = 0;
byte rates[RATE_SAMPLES];
long lastBeat = 0;
int beatAvg = 0;
unsigned long highPulseStartMs = 0;
bool sensorSosActive = false;
unsigned long fingerTouchUntilMs = 0;

BLEServer* pServer = nullptr;
BLECharacteristic* pPulseCharacteristic = nullptr;
bool deviceConnected = false;

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* s) override {
    deviceConnected = true;
    Serial.println("[BLE] phone connected");
  }
  void onDisconnect(BLEServer* s) override {
    deviceConnected = false;
    Serial.println("[BLE] phone disconnected, re-advertising");
    BLEDevice::startAdvertising(); // keep advertising so the phone can reconnect
  }
};

class CommandCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* ch) override {
    String value = ch->getValue().c_str();
    Serial.print("[BLE] received: ");
    Serial.println(value);
    int comma = value.indexOf(',');
    if (comma > 0) {
      classCode = value.charAt(0);
      distanceM = value.substring(comma + 1).toFloat();
    }
  }
};

void setup() {
  // Workaround for weak/laptop-only USB power: the BLE radio's own power-on
  // current spike (not the LEDs) was tripping brownout and hard-resetting
  // the board in a loop, even with a single dimmed LED. Disabling the
  // brownout detector stops that reset loop; dropping CPU clock and BLE TX
  // power reduces the actual current draw so it doesn't need to dip that far
  // in the first place. This is a workaround, not a real fix — a proper 5V/1A+
  // wall adapter + good cable remains the reliable long-term answer.
  WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0);
  setCpuFrequencyMhz(80);

  Serial.begin(115200);
  delay(200);
  Serial.println("\n[BOOT] EchoSenseLED starting...");

  pinMode(YELLOW_PIN, OUTPUT);
  pinMode(RED_PIN, OUTPUT);
  setYellow(false);
  setRed(false);

  // Hardware self-test: blink each LED 3x ONE AT A TIME (never both together —
  // that combined draw is what was browning out the board on laptop USB
  // power), independent of BLE/phone, so a wiring problem shows up
  // immediately without needing the app at all.
  Serial.println("[BOOT] LED self-test (yellow x3, then red x3)...");
  for (int i = 0; i < 3; i++) {
    setYellow(true);
    delay(200);
    setYellow(false);
    delay(200);
  }
  for (int i = 0; i < 3; i++) {
    setRed(true);
    delay(200);
    setRed(false);
    delay(200);
  }
  Serial.println("[BOOT] LED self-test done.");

  Wire.begin(21, 22);
  if (particleSensor.begin(Wire, I2C_SPEED_FAST)) {
    pulseSensorPresent = true;
    // Conservative LED brightness (0x1F, not the max 0xFF) — keeps the
    // sensor's own current draw low given this board is already tight on
    // laptop USB power.
    particleSensor.setup(0x1F, 4, 2, 100, 411, 4096);
    Serial.println("[BOOT] MAX3010x pulse sensor found.");
  } else {
    Serial.println("[BOOT] MAX3010x pulse sensor NOT found — SOS-on-high-pulse disabled, everything else unaffected.");
  }

  BLEDevice::init("AbleMind-EchoSense");
  // Lowest TX power: cuts the radio's peak current draw substantially. Range
  // drops (fine — the phone is meant to be right next to/on the user anyway).
  esp_ble_tx_power_set(ESP_BLE_PWR_TYPE_DEFAULT, ESP_PWR_LVL_N12);
  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new ServerCallbacks());

  BLEService* pService = pServer->createService(SERVICE_UUID);
  BLECharacteristic* pCharacteristic = pService->createCharacteristic(
      CHARACTERISTIC_UUID,
      BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  pCharacteristic->setCallbacks(new CommandCallbacks());

  pPulseCharacteristic = pService->createCharacteristic(
      PULSE_CHARACTERISTIC_UUID,
      BLECharacteristic::PROPERTY_NOTIFY);
  pPulseCharacteristic->addDescriptor(new BLE2902()); // required for the client to enable notifications

  pService->start();

  BLEAdvertising* pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->start();
  Serial.println("[BOOT] BLE advertising as 'AbleMind-EchoSense'. Ready.");
}

void applySosPattern(unsigned long now) {
  // SOS: fastest alternating strobe of any pattern — the single most
  // urgent, most attention-grabbing signal this board can produce.
  if (now - lastBlinkMs > 60) {
    lastBlinkMs = now;
    blinkState = !blinkState;
  }
  setYellow(blinkState);
  setRed(!blinkState);
}

void applyLeds() {
  unsigned long now = millis();

  // Sensor-triggered SOS (high sustained pulse, detected locally by this
  // board) overrides everything else, including a phone-sent classCode —
  // it's a physical panic signal and works even if BLE is down.
  if (sensorSosActive) {
    applySosPattern(now);
    return;
  }

  // Finger-touch feedback: single LED (yellow only, never both — same
  // brownout-avoidance reason as everything else here) blinking fast whenever
  // the pulse sensor has gotten a valid "finger present" IR reading recently.
  // Independent of whether a full BPM could be computed — a flaky I2C
  // connection can still register a touch even if it can't sustain a stable
  // enough read stream for heartbeat detection.
  if (millis() < fingerTouchUntilMs) {
    if (now - lastBlinkMs > 120) {
      lastBlinkMs = now;
      blinkState = !blinkState;
    }
    setYellow(blinkState);
    setRed(false);
    return;
  }

  if (classCode == 'N') {
    setYellow(false);
    setRed(false);
    return;
  }

  // Note: every pattern below alternates between the two LEDs rather than
  // lighting both at once — that combined draw is what was browning out the
  // board on laptop USB power. Alternating at different rates keeps the
  // patterns just as visually distinct without ever doubling up the current.

  if (classCode == 'X') {
    applySosPattern(now);
    return;
  }

  if (classCode == 'V') {
    // Fused hard-stop (sonar and/or vision): fast alternating strobe,
    // distinct rate from both stairs and SOS, to signal "stop now".
    if (now - lastBlinkMs > 90) {
      lastBlinkMs = now;
      blinkState = !blinkState;
    }
    setYellow(blinkState);
    setRed(!blinkState);
    return;
  }

  if (classCode == 'S') {
    // Stairs: distinct fast alternating pattern regardless of distance.
    if (now - lastBlinkMs > 150) {
      lastBlinkMs = now;
      blinkState = !blinkState;
    }
    setYellow(blinkState);
    setRed(!blinkState);
    return;
  }

  if (distanceM > 0 && distanceM < NEAR_THRESHOLD_M) {
    // Close obstacle: red, blink rate scales with proximity (closer = faster).
    unsigned long blinkIntervalMs = max(80.0f, distanceM * 400.0f);
    if (now - lastBlinkMs > blinkIntervalMs) {
      lastBlinkMs = now;
      blinkState = !blinkState;
    }
    setRed(blinkState);
    setYellow(false);
  } else {
    // Moderate distance: steady yellow.
    setYellow(true);
    setRed(false);
  }
}

unsigned long lastPulseStatusMs = 0;

void checkPulse() {
  if (!pulseSensorPresent) return;

  long irValue = particleSensor.getIR();

  // One status line per second instead of per-read — enough to see whether
  // the sensor connection is actually alive (irValue changing/nonzero) and
  // whether beatAvg is updating, without flooding the log like the raw I2C
  // error messages did.
  if (millis() - lastPulseStatusMs > 1000) {
    lastPulseStatusMs = millis();
    Serial.print("[PULSE] ir=");
    Serial.print(irValue);
    Serial.print(" beatAvg=");
    Serial.println(beatAvg);
  }

  if (checkForBeat(irValue)) {
    long delta = millis() - lastBeat;
    lastBeat = millis();
    float bpm = 60.0 / (delta / 1000.0);
    if (bpm > 20 && bpm < 255) {
      rates[rateSpot++] = (byte)bpm;
      rateSpot %= RATE_SAMPLES;
      int sum = 0;
      for (byte i = 0; i < RATE_SAMPLES; i++) sum += rates[i];
      beatAvg = sum / RATE_SAMPLES;
    }
  }

  bool fingerPresent = irValue > PULSE_IR_PRESENCE_THRESHOLD;
  if (fingerPresent) {
    bool wasTouching = millis() < fingerTouchUntilMs;
    fingerTouchUntilMs = millis() + FINGER_TOUCH_HOLD_MS;
    if (!wasTouching) {
      Serial.print("[PULSE] finger touch detected (ir=");
      Serial.print(irValue);
      Serial.println(") — yellow LED should be blinking now");
    }
  }
  bool highNow = fingerPresent && beatAvg >= PULSE_SOS_BPM;

  if (highNow) {
    if (highPulseStartMs == 0) highPulseStartMs = millis();
    bool wasActive = sensorSosActive;
    sensorSosActive = (millis() - highPulseStartMs) >= PULSE_SOS_SUSTAIN_MS;
    if (sensorSosActive && !wasActive) {
      Serial.print("[PULSE] sustained high BPM (");
      Serial.print(beatAvg);
      Serial.println(") — triggering local SOS");
    }
  } else {
    highPulseStartMs = 0;
    sensorSosActive = false;
  }

  static unsigned long lastNotifyMs = 0;
  if (deviceConnected && pPulseCharacteristic && millis() - lastNotifyMs > PULSE_NOTIFY_INTERVAL_MS) {
    lastNotifyMs = millis();
    char payload[16];
    snprintf(payload, sizeof(payload), "%d,%d", beatAvg, sensorSosActive ? 1 : 0);
    pPulseCharacteristic->setValue((uint8_t*)payload, strlen(payload));
    pPulseCharacteristic->notify();
  }
}

void loop() {
  checkPulse();
  applyLeds();
  delay(10);
}
