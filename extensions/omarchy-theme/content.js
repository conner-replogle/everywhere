// Hands everywhere the Omarchy theme, which the page applies when "Follow
// Omarchy" is its theme (apps/web/src/lib/theme.ts). It's left on <html> as
// data-omarchy-theme='{"name":"miasma","colors":{...}}', since the page
// can't see this script's world; no attribute means no Omarchy theme.

function hand(theme) {
  const root = document.documentElement;
  if (theme?.colors) root.dataset.omarchyTheme = JSON.stringify(theme);
  else delete root.dataset.omarchyTheme;
}

chrome.storage.local.get("theme").then(({ theme }) => hand(theme));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.theme) hand(changes.theme.newValue);
});
chrome.runtime.sendMessage("connect").catch(() => {});
