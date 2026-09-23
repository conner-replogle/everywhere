import { useMemo } from "react";
import { encode } from "uqr";
import { cn } from "@/lib/utils";

/**
 * QR code rendered locally as inline SVG; the value (a TOTP secret) never
 * leaves the browser. Always black on white with a 4-module quiet zone so
 * phone cameras read it regardless of the dark theme around it.
 */
export function QrCode({ value, size = 176, className }: { value: string; size?: number; className?: string }) {
  const { n, d } = useMemo(() => {
    const { data } = encode(value, { ecc: "M", border: 4 });
    let d = "";
    data.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) d += `M${x} ${y}h1v1h-1z`;
      });
    });
    return { n: data.length, d };
  }, [value]);

  return (
    <svg
      viewBox={`0 0 ${n} ${n}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      role="img"
      aria-label="QR code for your authenticator app"
      className={cn("shrink-0 rounded-md", className)}
    >
      <rect width={n} height={n} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}
