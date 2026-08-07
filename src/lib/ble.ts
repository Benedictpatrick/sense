/**
 * Web Bluetooth client for the ESP32 EchoSenseLED wearable (esp32/EchoSenseLED).
 * The phone does all sensing/inference; this just streams the result out so
 * the ESP32 can drive its two indicator LEDs. Optional — /infer works fully
 * without a connected ESP32.
 */

const SERVICE_UUID = "4fafc201-1fb5-459e-8fcc-c5c9c331914b";
const CHARACTERISTIC_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26a8";

const CLASS_CODES: Record<string, string> = {
  wall: "W",
  person: "P",
  doorway: "D",
  stairs: "S",
  none: "N",
};

export function bluetoothSupported(): boolean {
  return typeof navigator !== "undefined" && "bluetooth" in navigator;
}

export class EchoSenseLedDevice {
  private characteristic: BluetoothRemoteGATTCharacteristic | null = null;
  private device: BluetoothDevice | null = null;

  get connected(): boolean {
    return this.device?.gatt?.connected ?? false;
  }

  async connect(): Promise<void> {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }],
    });
    const server = await device.gatt!.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    this.characteristic = await service.getCharacteristic(CHARACTERISTIC_UUID);
    this.device = device;
  }

  disconnect(): void {
    this.device?.gatt?.disconnect();
    this.characteristic = null;
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
