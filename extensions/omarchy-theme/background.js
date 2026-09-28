// Holds a connection to the native host, which sends the Omarchy theme now
// and on every change, and keeps the latest in storage for the content
// script. An open native port also keeps this worker alive.

const HOST = "dev.replogle.everywhere.omarchy_theme";

let port = null;

function connect() {
  if (port) return;
  port = chrome.runtime.connectNative(HOST);
  port.onMessage.addListener((theme) => {
    chrome.storage.local.set({ theme });
  });
  port.onDisconnect.addListener(() => {
    console.warn("omarchy theme host disconnected:", chrome.runtime.lastError?.message);
    port = null;
  });
}

// Pages ask on load, which also reconnects after the host went away.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg === "connect") connect();
});
chrome.runtime.onStartup.addListener(connect);
connect();
