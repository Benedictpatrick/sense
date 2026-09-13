# EchoSenseLED (ESP32 wearable output)

Receives EchoSense classification results from the AbleMind web app over
Bluetooth Low Energy and drives two LEDs (yellow/red) as a proximity/hazard
indicator. The phone does all sensing and AI inference — this board only
displays the result.

## Wiring

- Yellow LED: anode → 220–330Ω resistor → **GPIO 5**, cathode → GND
- Red LED: anode → 220–330Ω resistor → **GPIO 18**, cathode → GND
- MAX3010x pulse sensor (I2C, optional): VIN → 3.3V, GND → GND, SDA → **GPIO 21**, SCL → **GPIO 22**

(Change `YELLOW_PIN`/`RED_PIN` in `src/main.cpp` if you wire different pins.)

The pulse sensor is optional — if it's not connected, the board logs
`MAX3010x pulse sensor NOT found` at boot and everything else (BLE, sonar/vision LEDs) works exactly as before.

## Flashing with PlatformIO (VS Code)

1. Install [VS Code](https://code.visualstudio.com/) if you don't have it.
2. In VS Code, open the Extensions panel (`Ctrl+Shift+X`), search for
   **PlatformIO IDE**, install it. Restart VS Code when prompted.
3. `File → Open Folder…` → select this folder
   (`esp32/EchoSenseLED`) — **not** the whole repo, this exact folder, since
   `platformio.ini` needs to be at the opened folder's root.
4. Plug the ESP32 into your computer via USB.
5. Click the PlatformIO icon in the sidebar → **Upload** (or the checkmark
   "Build" icon first if you want to just compile-check). First run will
   download the ESP32 toolchain automatically (~1-2 min, needs internet).
6. If upload fails with a port error, hold the **BOOT** button on the ESP32
   while upload starts (common on some dev boards).

## Testing

1. Power the ESP32 (USB is fine).
2. On your phone, open the AbleMind app in Chrome, go to `/infer`.
3. Scroll down to "ESP32 wearable (LEDs)" → tap **Connect ESP32** → pick
   `AbleMind-EchoSense` from the Bluetooth device list.
4. Tap **Start**. As it detects obstacles, the LEDs should react:
   - both off → nothing detected
   - yellow steady → obstacle at moderate distance
   - red, blinking faster as you get closer → obstacle nearby
   - yellow/red alternating (150ms) → stairs
   - yellow/red alternating fast (90ms) → fused hard-stop (sonar and/or
     vision both flagging an immediate hazard)
   - yellow/red alternating very fast (60ms) → SOS triggered (button, shake,
     shouted "help", the help gesture on /gesture, **or** the board's own
     pulse sensor detecting ≥120 BPM sustained for 3+ seconds — this one
     works even without the phone connected, since the board checks it
     locally)

To test the pulse-triggered SOS: place a finger flat on the MAX3010x sensor
and hold still for a steady reading. It won't trigger at a normal resting
heart rate — you'd need an actual elevated BPM (e.g. right after exercise) or
you can temporarily lower `PULSE_SOS_BPM` in `src/main.cpp` for a quick test.

LEDs are driven at reduced PWM brightness (not full digitalWrite HIGH) and no
pattern ever lights both LEDs at the same instant — this keeps peak current
draw low enough to run reliably off laptop USB power, which can't always
supply enough current for two LEDs at full brightness simultaneously.

Web Bluetooth requires Chrome (Android) and a secure (HTTPS) origin — the
deployed Vercel URL already satisfies this.
