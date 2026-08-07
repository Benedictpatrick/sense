/*
  EchoSenseLED — ESP32 BLE peripheral that receives EchoSense classification
  results from the AbleMind web app (Web Bluetooth, no native app needed)
  and drives two discrete LEDs as a wearable proximity/hazard indicator.

  The phone does all sensing + AI inference (unchanged) — this board is a
  pure output device: it does not sense anything itself.

  Wiring:
    YELLOW LED  anode -> 220-330ohm resistor -> GPIO 5  | cathode -> GND
    RED LED     anode -> 220-330ohm resistor -> GPIO 4  | cathode -> GND

  Protocol: the phone writes a short ASCII string to the characteristic on
  every inference cycle: "<classCode>,<distanceMeters>"
    classCode: W=wall  P=person  D=doorway  S=stairs  N=none
    e.g. "W,1.20"  or  "N,0.00"
*/

#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

#define YELLOW_PIN 5
#define RED_PIN 4

// Same UUIDs as the web app's src/lib/ble.ts — keep in sync if you change them.
#define SERVICE_UUID        "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define CHARACTERISTIC_UUID "beb5483e-36e1-4688-b7f5-ea07361b26a8"

#define NEAR_THRESHOLD_M 1.0

char classCode = 'N';
float distanceM = 0.0;
unsigned long lastBlinkMs = 0;
bool blinkState = false;

BLEServer* pServer = nullptr;
bool deviceConnected = false;

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* s) override { deviceConnected = true; }
  void onDisconnect(BLEServer* s) override {
    deviceConnected = false;
    BLEDevice::startAdvertising(); // keep advertising so the phone can reconnect
  }
};

class CommandCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* ch) override {
    String value = ch->getValue().c_str();
    int comma = value.indexOf(',');
    if (comma > 0) {
      classCode = value.charAt(0);
      distanceM = value.substring(comma + 1).toFloat();
    }
  }
};

void setup() {
  pinMode(YELLOW_PIN, OUTPUT);
  pinMode(RED_PIN, OUTPUT);
  digitalWrite(YELLOW_PIN, LOW);
  digitalWrite(RED_PIN, LOW);

  BLEDevice::init("AbleMind-EchoSense");
  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new ServerCallbacks());

  BLEService* pService = pServer->createService(SERVICE_UUID);
  BLECharacteristic* pCharacteristic = pService->createCharacteristic(
      CHARACTERISTIC_UUID,
      BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  pCharacteristic->setCallbacks(new CommandCallbacks());
  pService->start();

  BLEAdvertising* pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->start();
}

void applyLeds() {
  unsigned long now = millis();

  if (classCode == 'N') {
    digitalWrite(YELLOW_PIN, LOW);
    digitalWrite(RED_PIN, LOW);
    return;
  }

  if (classCode == 'S') {
    // Stairs: distinct fast alternating pattern regardless of distance.
    if (now - lastBlinkMs > 150) {
      lastBlinkMs = now;
      blinkState = !blinkState;
    }
    digitalWrite(YELLOW_PIN, blinkState ? HIGH : LOW);
    digitalWrite(RED_PIN, blinkState ? LOW : HIGH);
    return;
  }

  if (distanceM > 0 && distanceM < NEAR_THRESHOLD_M) {
    // Close obstacle: red, blink rate scales with proximity (closer = faster).
    unsigned long blinkIntervalMs = max(80.0f, distanceM * 400.0f);
    if (now - lastBlinkMs > blinkIntervalMs) {
      lastBlinkMs = now;
      blinkState = !blinkState;
    }
    digitalWrite(RED_PIN, blinkState ? HIGH : LOW);
    digitalWrite(YELLOW_PIN, LOW);
  } else {
    // Moderate distance: steady yellow.
    digitalWrite(YELLOW_PIN, HIGH);
    digitalWrite(RED_PIN, LOW);
  }
}

void loop() {
  applyLeds();
  delay(10);
}
