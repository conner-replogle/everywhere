import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // No async clipboard (plain-http origin such as a tailnet IP) or permission denied.
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={async () => {
        await copyText(text);
        setCopied(true);
      }}
    >
      {copied ? <CheckIcon className="text-live" /> : <CopyIcon />}
      {copied ? "Copied" : label}
    </Button>
  );
}
