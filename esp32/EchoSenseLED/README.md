# EchoSenseLED (ESP32 wearable output)

Receives EchoSense classification results from the AbleMind web app over
Bluetooth Low Energy and drives two LEDs (yellow/red) as a proximity/hazard
indicator. The phone does all sensing and AI inference — this board only
displays the result.

## Wiring

- Yellow LED: anode → 220–330Ω resistor → **GPIO 5**, cathode → GND
- Red LED: anode → 220–330Ω resistor → **GPIO 4**, cathode → GND

(Change `YELLOW_PIN`/`RED_PIN` in `src/main.cpp` if you wire different pins.)

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
   - yellow/red alternating fast → stairs (distinct high-risk pattern)

Web Bluetooth requires Chrome (Android) and a secure (HTTPS) origin — the
deployed Vercel URL already satisfies this.
