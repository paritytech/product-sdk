export function getEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
}

export function setResult(id: string, text: string, isError = false): void {
  const el = getEl(id);
  el.textContent = text;
  el.classList.toggle("err", isError);
}

export function log(line: string): void {
  const box = getEl("log");
  const row = document.createElement("div");

  const ts = document.createElement("span");
  ts.className = "log-ts";
  ts.textContent = `${new Date().toLocaleTimeString()}  `;

  const msg = document.createElement("span");
  msg.textContent = line; // textContent → safe against arbitrary error strings

  row.append(ts, msg);
  box.prepend(row);
}
