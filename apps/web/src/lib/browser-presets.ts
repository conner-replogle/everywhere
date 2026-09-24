// Mirrors daemon/internal/browser/presets.go: devices the browser tab can
// emulate, in CSS pixels in their natural orientation.

export interface BrowserPreset {
  id: string;
  label: string;
  category: "Phone" | "Tablet" | "Desktop";
  width: number;
  height: number;
}

export const BROWSER_PRESETS: BrowserPreset[] = [
  { id: "iphone-se", label: "iPhone SE", category: "Phone", width: 375, height: 667 },
  { id: "iphone-xr", label: "iPhone XR", category: "Phone", width: 414, height: 896 },
  { id: "iphone-12-pro", label: "iPhone 12 Pro", category: "Phone", width: 390, height: 844 },
  { id: "iphone-14-pro-max", label: "iPhone 14 Pro Max", category: "Phone", width: 430, height: 932 },
  { id: "pixel-7", label: "Pixel 7", category: "Phone", width: 412, height: 915 },
  { id: "galaxy-s8-plus", label: "Samsung Galaxy S8+", category: "Phone", width: 360, height: 740 },
  { id: "galaxy-s20-ultra", label: "Samsung Galaxy S20 Ultra", category: "Phone", width: 412, height: 915 },
  { id: "galaxy-z-fold-5", label: "Galaxy Z Fold 5", category: "Phone", width: 344, height: 882 },
  { id: "galaxy-a51", label: "Samsung Galaxy A51/71", category: "Phone", width: 412, height: 914 },
  { id: "ipad-mini", label: "iPad Mini", category: "Tablet", width: 768, height: 1024 },
  { id: "ipad-air", label: "iPad Air", category: "Tablet", width: 820, height: 1180 },
  { id: "ipad-pro", label: "iPad Pro", category: "Tablet", width: 1024, height: 1366 },
  { id: "surface-pro-7", label: "Surface Pro 7", category: "Tablet", width: 912, height: 1368 },
  { id: "surface-duo", label: "Surface Duo", category: "Tablet", width: 540, height: 720 },
  { id: "zenbook-fold", label: "Asus Zenbook Fold", category: "Tablet", width: 853, height: 1280 },
  { id: "nest-hub", label: "Nest Hub", category: "Tablet", width: 1024, height: 600 },
  { id: "nest-hub-max", label: "Nest Hub Max", category: "Tablet", width: 1280, height: 800 },
  { id: "laptop", label: "Laptop", category: "Desktop", width: 1280, height: 800 },
  { id: "desktop", label: "Desktop", category: "Desktop", width: 1920, height: 1080 },
];

export const presetById = (id: string | undefined) => BROWSER_PRESETS.find((p) => p.id === id);
