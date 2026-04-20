export function getEl<T extends HTMLElement>(id: string): T {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Missing element #${id} in HTML`);
    return el as T;
}

export type LogLevel = "ok" | "err" | "info" | "state";

export function appendLog($log: HTMLElement, msg: string, level: LogLevel = "info"): void {
    const ts = new Date().toLocaleTimeString();
    const div = document.createElement("div");
    div.className = `log-${level}`;
    div.innerHTML = `<span class="ts">[${ts}]</span> ${msg}`;
    $log.appendChild(div);
    $log.scrollTop = $log.scrollHeight;
}

export function toHex(bytes: Uint8Array): string {
    return `0x${Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")}`;
}
