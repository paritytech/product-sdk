import { requestPermission, requestDevicePermission } from "@parity/product-sdk-host";
import type { RemotePermission, DevicePermissionKind } from "@parity/product-sdk-host";

type RemoteTag = RemotePermission["tag"];

// Two permission families the host exposes.
export const REMOTE_PERMISSIONS: RemoteTag[] = [
  "ChainSubmit",
  "StatementSubmit",
  "PreimageSubmit",
  "WebRtc",
  "Remote",
];
export const DEVICE_PERMISSIONS: DevicePermissionKind[] = [
  "Notifications",
  "Camera",
  "Microphone",
  "Bluetooth",
  "NFC",
  "Location",
  "Clipboard",
  "OpenUrl",
  "Biometrics",
];

export type PermissionTag = RemoteTag | DevicePermissionKind;

const isDevice = (tag: PermissionTag): tag is DevicePermissionKind =>
  (DEVICE_PERMISSIONS as string[]).includes(tag);

// Ask the host for a permission. The product can't grant it — the host asks the user.
export function askPermission(tag: PermissionTag): Promise<boolean> {
  // Device permissions (camera, microphone, …) use a separate host call.
  if (isDevice(tag)) return requestDevicePermission(tag);

  // "Remote" carries a list of peer ids; the other remote tags carry no value.
  const permission = (
    tag === "Remote" ? { tag, value: [] } : { tag, value: undefined }
  ) as RemotePermission;
  return requestPermission(permission);
}
