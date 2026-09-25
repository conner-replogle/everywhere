/** A titled card on a settings page. */
export function Section({
  title,
  description,
  children,
  aside,
}: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  aside?: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border bg-card">
      <header className="flex items-start gap-3 border-b px-4 py-3 max-sm:flex-wrap">
        <div className="min-w-0 flex-1">
          <h2 className="font-medium">{title}</h2>
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
        {aside}
      </header>
      <div className="px-4 py-4">{children}</div>
    </section>
  );
}
