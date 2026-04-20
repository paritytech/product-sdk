/**
 * Thin DOM helpers. Non-null getters so a broken index.html fails loudly.
 */

export function getEl<T extends HTMLElement>(id: string): T {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Missing element #${id} in HTML`);
    return el as T;
}

export type LogLevel = "ok" | "err" | "info";

export function appendLog($log: HTMLElement, msg: string, level: LogLevel = "info"): void {
    const ts = new Date().toLocaleTimeString();
    const cls = `log-${level}`;
    const div = document.createElement("div");
    div.className = cls;
    div.innerHTML = `<span class="ts">[${ts}]</span> ${msg}`;
    $log.appendChild(div);
    $log.scrollTop = $log.scrollHeight;
}
