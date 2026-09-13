/**
 * Web Bluetooth client for the ESP32 EchoSenseLED wearable (esp32/EchoSenseLED).
 * The phone does all sensing/inference; this just streams the result out so
 * the ESP32 can drive its two indicator LEDs. Optional — /infer works fully
 * without a connected ESP32.
 */

const SERVICE_UUID = "4fafc201-1fb5-459e-8fcc-c5c9c331914b";
const CHARACTERISTIC_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26a8";
// Board -> phone direction (notify). Must match PULSE_CHARACTERISTIC_UUID in esp32/EchoSenseLED/src/main.cpp.
const PULSE_CHARACTERISTIC_UUID = "c1a9a3e2-2b0a-4f7a-9c2e-6f6a1b6e5d3a";

const CLASS_CODES: Record<string, string> = {
  wall: "W",
  person: "P",
  doorway: "D",
  stairs: "S",
  none: "N",
  "hard-stop": "V",
  sos: "X",
};

export function bluetoothSupported(): boolean {
  return typeof navigator !== "undefined" && "bluetooth" in navigator;
}

export interface PulseUpdate {
  bpm: number;
  sosActive: boolean;
}

export class EchoSenseLedDevice {
  private characteristic: BluetoothRemoteGATTCharacteristic | null = null;
  private pulseCharacteristic: BluetoothRemoteGATTCharacteristic | null = null;
  private device: BluetoothDevice | null = null;
  private pulseListeners = new Set<(update: PulseUpdate) => void>();
  private handlePulseNotification = (event: Event) => {
    const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
    if (!value) return;
    const text = new TextDecoder().decode(value);
    const [bpmStr, sosStr] = text.split(",");
    const bpm = parseInt(bpmStr, 10);
    if (Number.isNaN(bpm) || bpm < 0 || bpm > 255) return; // malformed/partial BLE payload — drop it rather than act on garbage
    // Defense in depth: the board only ever sends sosActive=1 alongside a
    // BPM that's already >=120 (its own sustained-threshold logic), so a "1"
    // paired with an implausible/low BPM means a corrupted notification, not
    // a real trigger — never worth risking a false emergency dispatch over.
    const update: PulseUpdate = { bpm, sosActive: sosStr === "1" && bpm >= 100 };
    for (const fn of this.pulseListeners) fn(update);
  };

  get connected(): boolean {
    return this.device?.gatt?.connected ?? false;
  }

  /** Returns an unsubscribe function. Board sends updates ~2x/second while connected. */
  onPulseUpdate(fn: (update: PulseUpdate) => void): () => void {
    this.pulseListeners.add(fn);
    return () => this.pulseListeners.delete(fn);
  }

  async connect(): Promise<void> {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }],
    });
    const server = await device.gatt!.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    this.characteristic = await service.getCharacteristic(CHARACTERISTIC_UUID);
    this.device = device;

    // Pulse notify is optional — an older-flashed board without this
    // characteristic still works for everything else, it just won't report BPM.
    try {
      this.pulseCharacteristic = await service.getCharacteristic(PULSE_CHARACTERISTIC_UUID);
      await this.pulseCharacteristic.startNotifications();
      this.pulseCharacteristic.addEventListener("characteristicvaluechanged", this.handlePulseNotification);
    } catch {
      this.pulseCharacteristic = null;
    }
  }

  disconnect(): void {
    this.pulseCharacteristic?.removeEventListener("characteristicvaluechanged", this.handlePulseNotification);
    this.device?.gatt?.disconnect();
    this.characteristic = null;
    this.pulseCharacteristic = null;
    this.device = null;
  }

  /** Sends the current classification result; no-op if not connected. */
  async send(label: string, distanceM: number): Promise<void> {
    if (!this.characteristic) return;
    const code = CLASS_CODES[label] ?? "N";
    const payload = `${code},${distanceM.toFixed(2)}`;
    try {
      await this.characteristic.writeValueWithoutResponse(new TextEncoder().encode(payload));
    } catch {
      // Transient BLE write failures shouldn't break the sense/infer/act loop.
    }
  }
}

let sharedDevice: EchoSenseLedDevice | null = null;

/**
 * One BLE connection shared across pages (module state survives Next.js
 * client-side navigation) — so a wearable connected from /infer stays
 * connected when the user navigates to /gesture, and SOS triggered from
 * either page can still drive the same LEDs.
 */
export function getSharedLedDevice(): EchoSenseLedDevice {
  if (!sharedDevice) sharedDevice = new EchoSenseLedDevice();
  return sharedDevice;
}
