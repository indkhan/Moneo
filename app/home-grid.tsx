"use client";

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type SyntheticEvent } from "react";
import { DndContext, DragOverlay, MouseSensor, TouchSensor, pointerWithin, useSensor, useSensors,
  type Announcements, type CollisionDetection, type DragEndEvent, type DragMoveEvent, type DragStartEvent, type UniqueIdentifier } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable } from "@dnd-kit/sortable";
import { GripHorizontal, Plus, X } from "lucide-react";
import { HomeCardSize } from "@/components/cards/card-view";
import { CARD_SIZES, type CardSize } from "@/lib/cards/sizes";
import { distanceToBox, dropSide, moveWidget, type Point } from "@/lib/home-grid-drop";
import { useTimeout } from "@/lib/use-timeout";
import { resizeHomeCard, saveHomeLayout } from "./dashboard-actions";
import { SectionFallback } from "./section-fallback";

type Layout = { items: string[]; sizes: Record<string, CardSize> };
type Drag = { id: string; from: string[]; clone: HTMLElement; width: number; height: number; touch: boolean };
type Notice = { text: string; action?: { label: string; run: () => void } };
export type HomeGridProps = Layout & { version: number; widgets: Record<string, ReactNode>; labels: Record<string, string>; options: Record<string, CardSize[]> };

const CARD_KEY = "card:";
const stay = () => null;
const autoScroll = { threshold: { x: 0, y: 0.12 }, acceleration: 10 };
const dragsWidget = (target: EventTarget) => target instanceof Element && !!target.closest("h2, h3") && !target.closest("a, button, input, select, textarea, summary");
const nearest = (options: CardSize[], columns: number) => options.reduce((best, size) => Math.abs(CARD_SIZES[size].columns - columns) < Math.abs(CARD_SIZES[best].columns - columns) ? size : best);

export function HomeGrid({ version, items, sizes, widgets, labels, options }: HomeGridProps) {
  const [layout, setLayout] = useState<Layout>({ items, sizes });
  const currentLayout = useRef(layout);
  useLayoutEffect(() => { currentLayout.current = layout; }, [layout]);
  const saved = useRef(version);
  const queue = useRef(Promise.resolve());
  const [drag, setDrag] = useState<Drag | null>(null);
  const [resizing, setResizing] = useState<{ key: string; size: CardSize } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [adding, setAdding] = useState<string[]>([]);
  const [menu, setMenu] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const [said, setSaid] = useState("");
  const grid = useRef<HTMLDivElement>(null);
  const rects = useRef(new Map<string, { x: number; y: number }>());
  const skip = useRef<string | null>(null);
  const pointer = useRef<Point | null>(null);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  );

  function measure() {
    const origin = grid.current?.getBoundingClientRect();
    if (!origin) return [];
    return [...grid.current!.querySelectorAll<HTMLElement>(":scope > [data-widget]")].map(node => {
      node.getAnimations().forEach(animation => animation.cancel());
      const rect = node.getBoundingClientRect();
      const at = { x: rect.left - origin.left, y: rect.top - origin.top };
      return [node, at] as const;
    });
  }
  useLayoutEffect(() => {
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const [node, at] of measure()) {
      const key = node.dataset.widget!, from = rects.current.get(key);
      if (from && !still && key !== drag?.id && (from.x !== at.x || from.y !== at.y)) node.animate([{ transform: `translate(${from.x - at.x}px, ${from.y - at.y}px)` }, { transform: "none" }], { duration: 220, easing: "cubic-bezier(.2,.8,.2,1)" });
      rects.current.set(key, at);
    }
  }, [layout, resizing]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const node = grid.current;
    if (!node) return;
    const rows = new ResizeObserver(entries => {
      for (const entry of entries) (entry.target as HTMLElement).style.setProperty("--rows", String(Math.ceil((entry.borderBoxSize[0].blockSize + 16) / 4)));
      node.dataset.masonry = "";
    });
    for (const child of node.children) rows.observe(child);
    return () => rows.disconnect();
  }, [layout.items, adding]);
  const remember = () => { for (const [node, at] of measure()) rects.current.set(node.dataset.widget!, at); };

  useTimeout(() => setNotice(null), notice && !notice.action ? 6000 : null, notice);
  useEffect(() => {
    if (!selected) return;
    const away = (event: PointerEvent) => { if (!(event.target as Element).closest(`[data-widget="${CSS.escape(selected)}"]`)) setSelected(null); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [selected]);

  function save(run: () => Promise<{ version: number } | { error: string } | void>) {
    queue.current = queue.current.then(async () => {
      const result = await run().catch(() => ({ error: "Home could not be saved" }));
      if (result && "error" in result) return setNotice({ text: `${result.error}. Reload to see the latest.`, action: { label: "Reload", run: () => location.reload() } });
      if (result) saved.current = result.version;
    });
  }
  const persist = (next: Layout, added = false) => save(() => saveHomeLayout(saved.current, next.items, next.sizes, added));
  function change(next: Layout, added = false) { remember(); setLayout(next); persist(next, added); }

  function dragStart({ active, activatorEvent }: DragStartEvent) {
    const id = String(active.id), node = grid.current?.querySelector<HTMLElement>(`:scope > [data-widget="${CSS.escape(id)}"]`);
    if (!node) return;
    remember();
    const clone = node.cloneNode(true) as HTMLElement;
    clone.removeAttribute("data-widget");
    clone.querySelectorAll("[id]").forEach(element => element.removeAttribute("id"));
    const canvases = clone.querySelectorAll("canvas");
    node.querySelectorAll("canvas").forEach((canvas, index) => canvases[index]?.getContext("2d")?.drawImage(canvas, 0, 0));
    clone.inert = true;
    const touch = typeof TouchEvent !== "undefined" && activatorEvent instanceof TouchEvent;
    if (touch) navigator.vibrate?.(10);
    setSelected(null);
    setDrag({ id, from: layout.items, clone, width: node.offsetWidth, height: node.offsetHeight, touch });
  }
  const nearestWidget: CollisionDetection = args => {
    pointer.current = args.pointerCoordinates;
    const within = pointerWithin(args);
    if (within.length || !args.pointerCoordinates) return within;
    const at = args.pointerCoordinates;
    return args.droppableContainers.flatMap(container => {
      const rect = args.droppableRects.get(container.id);
      return rect?.width ? [{ id: container.id, data: { droppableContainer: container, value: distanceToBox(rect, at) } }] : [];
    }).sort((a, b) => a.data.value - b.data.value).slice(0, 1);
  };
  function dragMove({ active, over }: DragMoveEvent) {
    const at = pointer.current;
    if (!over || !at || over.id === active.id) { skip.current = null; return; }
    const side = dropSide(over.rect, at);
    const target = `${over.id}:${side}`;
    if (target === skip.current) return;
    skip.current = target;
    remember();
    setLayout(current => ({ ...current, items: moveWidget(current.items, String(active.id), String(over.id), side) }));
  }
  function dragEnd(event: DragEndEvent | null) {
    if (!drag) return;
    skip.current = null;
    setDrag(null);
    if (!event) return setLayout(current => ({ ...current, items: drag.from }));
    if (layout.items.join() !== drag.from.join()) persist(layout);
    else if (drag.touch) setSelected(drag.id);
  }

  function resize(key: string, size: CardSize) {
    const next = { ...layout, sizes: { ...layout.sizes, [key]: size } };
    remember();
    setLayout(next);
    if (key.startsWith(CARD_KEY)) save(() => resizeHomeCard(key.slice(CARD_KEY.length), size));
    else persist(next);
  }
  function startResize(key: string, event: ReactPointerEvent<HTMLElement>) {
    const handle = event.currentTarget, node = handle.closest<HTMLElement>("[data-widget]"), area = grid.current;
    if (!node || !area || event.button !== 0) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    const gap = parseFloat(getComputedStyle(area).columnGap) || 0, column = (area.clientWidth + gap) / 6;
    const startX = event.clientX, startWidth = node.getBoundingClientRect().width, from = layout.sizes[key];
    let size = from;
    const move = (moved: PointerEvent) => {
      const next = nearest(options[key], (startWidth + moved.clientX - startX + gap) / column);
      if (next !== size) { size = next; remember(); setResizing({ key, size }); }
    };
    const end = (event: PointerEvent) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      setResizing(null);
      if (event.type !== "pointercancel" && size !== from) resize(key, size);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end, { once: true });
    handle.addEventListener("pointercancel", end, { once: true });
  }
  function moveKey(key: string, event: KeyboardEvent) {
    const by = ({ ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 } as Record<string, number>)[event.key];
    if (!by) return;
    event.preventDefault();
    const from = layout.items.indexOf(key), to = from + by;
    if (to < 0 || to >= layout.items.length) return;
    change({ ...layout, items: arrayMove(layout.items, from, to) });
    setSaid(`${labels[key] ?? "Widget"} moved to position ${to + 1} of ${layout.items.length}.`);
    requestAnimationFrame(() => grid.current?.querySelector<HTMLElement>(`:scope > [data-widget="${CSS.escape(key)}"] [data-grip]`)?.focus());
  }
  function resizeKey(key: string, event: KeyboardEvent) {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const choices = options[key], next = choices[choices.indexOf(layout.sizes[key]) + step];
    if (!step) return;
    event.preventDefault();
    if (!next) return;
    resize(key, next);
    setSaid(`${labels[key] ?? "Widget"} is now ${next}.`);
  }

  function hide(key: string) {
    const before = layout;
    setSelected(null);
    change({ ...layout, items: layout.items.filter(item => item !== key) });
    setNotice({ text: `${labels[key] ?? "Widget"} hidden`, action: { label: "Undo", run: () => {
      setNotice(null);
      const current = currentLayout.current;
      const items = current.items.filter(item => item !== key);
      items.splice(Math.min(before.items.indexOf(key), items.length), 0, key);
      setAdding(current => current.includes(key) ? current : [...current, key]);
      change({ ...current, items }, true);
    } } });
  }
  function add(key: string) {
    setMenu(false);
    setAdding(current => [...current, key]);
    change({ ...layout, items: [...layout.items, key] }, true);
  }

  const shown = layout.items.filter(key => Object.hasOwn(widgets, key) || adding.includes(key));
  const hidden = Object.keys(options).filter(key => !layout.items.includes(key));
  const name = (id: UniqueIdentifier) => labels[String(id)] ?? "Widget";
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${name(active.id)}.`,
    onDragOver: ({ active, over }) => over ? `${name(active.id)} is at position ${shown.indexOf(String(active.id)) + 1} of ${shown.length}.` : undefined,
    onDragEnd: ({ active }) => `${name(active.id)} dropped at position ${shown.indexOf(String(active.id)) + 1}.`,
    onDragCancel: ({ active }) => `Moving ${name(active.id)} was cancelled.`,
  };

  return <DndContext id="home-grid" sensors={sensors} autoScroll={autoScroll} collisionDetection={nearestWidget} onDragStart={dragStart} onDragMove={dragMove} onDragEnd={dragEnd} onDragCancel={() => dragEnd(null)}
    accessibility={{ announcements, screenReaderInstructions: { draggable: "Use the arrow keys to move this widget one place at a time." } }}>
    <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
      {customizing && <p className="mr-auto text-sm text-muted-foreground">Drag a widget by its handle, or focus the handle and use the arrow keys. On a phone, hold a widget to drag it.</p>}
      {hidden.length > 0 && <div className="relative">
        <button type="button" aria-expanded={menu} onClick={() => setMenu(open => !open)}
          className="flex min-h-11 items-center gap-1.5 rounded-lg border border-input px-3 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground lg:min-h-9">
          <Plus className="size-4" aria-hidden="true" />Add widget</button>
        {menu && <ul aria-label="Hidden widgets" className="absolute top-full right-0 z-20 mt-2 w-max min-w-56 overflow-hidden rounded-xl border border-border bg-card py-1 shadow-lg">
          {hidden.map(key => <li key={key}><button type="button" onClick={() => add(key)} className="block w-full px-4 py-2.5 text-left text-sm hover:bg-muted">{labels[key]}</button></li>)}
        </ul>}
      </div>}
      <button type="button" aria-pressed={customizing} onClick={() => { setCustomizing(on => !on); setMenu(false); }} className="min-h-11 rounded-lg px-3 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground lg:min-h-9">{customizing ? "Done" : "Customize"}</button>
    </div>
    <SortableContext items={shown} strategy={stay}>
      <div ref={grid} className="grid items-start gap-4 lg:grid-flow-row-dense lg:grid-cols-6 lg:data-masonry:auto-rows-[4px] lg:data-masonry:gap-y-0 lg:data-masonry:[&>*]:[grid-row-end:span_var(--rows,1)]">
        {shown.map(key => {
          const size = resizing?.key === key ? resizing.size : layout.sizes[key] ?? "M";
          return <Widget key={key} id={key} label={labels[key] ?? "Widget"} size={size} lifted={drag?.id === key} options={options[key] ?? []} selected={selected === key || customizing} resizing={resizing?.key === key}
            onHide={() => hide(key)} onMoveKey={event => moveKey(key, event)} onResizeStart={event => startResize(key, event)} onResizeKey={event => resizeKey(key, event)}>
            <HomeCardSize.Provider value={layout.sizes[key] ?? null}>{widgets[key] ?? <SectionFallback title={labels[key] ?? "Widget"} />}</HomeCardSize.Provider>
          </Widget>;
        })}
      </div>
    </SortableContext>
    <DragOverlay dropAnimation={{ duration: 200, easing: "cubic-bezier(.2,.8,.2,1)" }}>
      {drag && <div ref={node => { if (node && !node.firstChild) node.append(drag.clone); }} style={{ width: drag.width, height: drag.height }}
        className="pointer-events-none rotate-[0.6deg] scale-[1.02] cursor-grabbing rounded-2xl shadow-2xl ring-1 ring-border [&>*]:h-full [&>*>section]:h-full" />}
    </DragOverlay>
    <p aria-live="polite" className="sr-only">{said}</p>
    {notice && <div role="status" className="fixed inset-x-0 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-50 lg:bottom-6 mx-auto flex w-fit max-w-[calc(100%-2rem)] items-center gap-4 rounded-xl bg-foreground px-4 py-3 text-sm text-background shadow-lg">
      <span>{notice.text}</span>
      {notice.action && <button type="button" onClick={notice.action.run} className="font-medium underline-offset-2 hover:underline">{notice.action.label}</button>}
      {notice.action && <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)} className="-mr-1 rounded p-1 hover:bg-background/20"><X className="size-4" aria-hidden="true" /></button>}
    </div>}
  </DndContext>;
}

type WidgetProps = { id: string; label: string; size: CardSize; lifted: boolean; options: CardSize[]; selected: boolean; resizing: boolean; children: ReactNode;
  onHide: () => void; onMoveKey: (event: KeyboardEvent) => void; onResizeStart: (event: ReactPointerEvent<HTMLElement>) => void; onResizeKey: (event: KeyboardEvent) => void };

function Widget({ id, label, size, lifted, options, selected, resizing, children, onHide, onMoveKey, onResizeStart, onResizeKey }: WidgetProps) {
  const { setNodeRef, setActivatorNodeRef, listeners, attributes } = useSortable({ id });
  const { onTouchStart, onMouseDown } = (listeners ?? {}) as Record<string, (event: SyntheticEvent) => void>;
  const tools = `transition-opacity ${lifted ? "invisible" : selected || resizing ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"}`;
  return <div ref={setNodeRef} data-widget={id} onTouchStart={onTouchStart} onMouseDown={event => { if (dragsWidget(event.target)) onMouseDown?.(event); }}
    className={`group relative min-w-0 ${CARD_SIZES[size].span} [&:has(>[data-tools]:first-child)]:hidden touch-manipulation [-webkit-touch-callout:none] pointer-coarse:select-none [&>section]:h-full [&_h2]:cursor-grab [&_h3:first-child]:cursor-grab ${lifted ? "rounded-2xl bg-muted/50 outline-2 outline-offset-0 outline-dashed outline-input [&>*]:opacity-0" : ""} ${selected ? "rounded-2xl outline-2 outline-brand" : ""}`}>
    {children}
    <div data-tools className={`absolute -top-3 left-1/2 z-10 flex -translate-x-1/2 items-center rounded-full border border-border bg-card shadow-sm ${tools}`}>
      <button type="button" ref={setActivatorNodeRef} {...attributes} aria-label={`Move ${label}`} data-grip title="Drag to move" onMouseDown={onMouseDown} onKeyDown={onMoveKey}
        className="flex h-7 cursor-grab items-center rounded-l-full px-2.5 pointer-coarse:h-11 pointer-coarse:px-4 text-muted-foreground hover:text-foreground active:cursor-grabbing"><GripHorizontal className="size-4" aria-hidden="true" /></button>
      <button type="button" aria-label={`Hide ${label}`} title="Hide" onClick={onHide}
        className="flex h-7 items-center rounded-r-full border-l border-border px-2 pointer-coarse:h-11 pointer-coarse:px-4 text-muted-foreground hover:text-foreground"><X className="size-3.5" aria-hidden="true" /></button>
    </div>
    {options.length > 1 && <button type="button" aria-label={`Resize ${label}, now ${size}`} title="Drag to resize" onPointerDown={onResizeStart} onKeyDown={onResizeKey}
      className={`absolute top-1/2 -right-2 z-10 hidden h-12 w-4 -translate-y-1/2 cursor-ew-resize touch-none items-center justify-center lg:flex ${tools}`}>
      <span className="h-10 w-1.5 rounded-full bg-input group-hover:bg-muted-foreground/60" aria-hidden="true" /></button>}
  </div>;
}
