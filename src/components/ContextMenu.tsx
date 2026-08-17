import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type MenuItem = {
  label: string;
  icon?: React.ReactNode;
  danger?: boolean;
  onSelect(): void;
};

/**
 * A menu anchored to a point, clamped so it never opens off-screen. Rendered
 * inline rather than in a portal because the detail view is already the
 * top-most layer.
 */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const { width, height } = node.getBoundingClientRect();
    const margin = 8;
    setPosition({
      left: Math.max(margin, Math.min(x, window.innerWidth - width - margin)),
      top: Math.max(margin, Math.min(y, window.innerHeight - height - margin)),
    });
  }, [x, y]);

  useEffect(() => {
    const dismiss = (event: Event) => {
      if (ref.current?.contains(event.target as Node)) return;
      onClose();
    };
    // `capture` so a click on the page below closes the menu before that
    // element's own handler runs and navigates away underneath it.
    window.addEventListener("pointerdown", dismiss, { capture: true });
    const dismissWithoutTarget = () => onClose();
    window.addEventListener("resize", dismissWithoutTarget);
    window.addEventListener("scroll", dismissWithoutTarget, true);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", dismiss, { capture: true });
      window.removeEventListener("resize", dismissWithoutTarget);
      window.removeEventListener("scroll", dismissWithoutTarget, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{ left: position.left, top: position.top }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          className={item.danger ? "danger" : undefined}
          onClick={() => {
            item.onSelect();
            onClose();
          }}
        >
          {item.icon}
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  );
}
