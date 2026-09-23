import type * as React from "react";

export function CenteredMessage({
  title,
  body,
  children,
}: {
  title: string;
  body?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <h1 className="text-[15px] font-semibold">{title}</h1>
        {body && <p className="text-muted-foreground">{body}</p>}
        {children}
      </div>
    </div>
  );
}
