import { render } from "preact";
import { App } from "./app.tsx";
import { boot, initLifecycle } from "./state.ts";
import "./styles.css";

initLifecycle();
void boot();
render(<App />, document.getElementById("app")!);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  addEventListener("load", () => void navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
