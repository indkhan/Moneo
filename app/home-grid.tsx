"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, pointerWithin, useSensor, useSensors, type CollisionDetection, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Check, GripHorizontal, LayoutGrid } from "lucide-react";
import { moveDashboardWidgets } from "./dashboard-actions";

export type HomeWidget = { key: string; label: string; span: string; node: ReactNode };
// Cards differ in width, so shuffling them live jumps around; the others hold still and the drop target is outlined.
const stayPut = () => null;
// The card under the pointer is the target (a big card's center can sit over a neighbour); the keyboard has no pointer.
const underPointer: CollisionDetection = args => { const hits = pointerWithin(args); return hits.length ? hits : closestCenter(args); };

function Card({ widget, editing }: { widget: HomeWidget; editing: boolean }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging, isOver } = useSortable({ id: widget.key });
  // The handle sits on the card's top edge, clear of each card's own header links; with a mouse it shows on hover, on touch in edit mode.
  return <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }}
    className={`group relative min-w-0 ${widget.span} [&>section]:h-full ${isDragging ? "z-20 opacity-80 shadow-lg" : ""} ${isOver && !isDragging ? "rounded-xl outline-2 outline-offset-4 outline-brand" : editing ? "min-h-12 rounded-xl outline-2 outline-offset-4 outline-border outline-dashed" : ""}`}>
    {widget.node}
    <button type="button" ref={setActivatorNodeRef} {...attributes} {...listeners} aria-label={`Move ${widget.label}`} title="Drag to move"
      className={`absolute -top-3 left-1/2 z-10 h-6 w-12 -translate-x-1/2 touch-none cursor-grab items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-sm hover:text-foreground active:cursor-grabbing
        ${editing ? "flex" : "hidden pointer-fine:flex pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:focus-visible:opacity-100"}`}>
      <GripHorizontal className="size-4" aria-hidden="true" />
    </button>
  </div>;
}

/** Home's widget grid: drag a card's handle to reorder it, saved at once; touch screens drag in edit mode so scrolling stays scrolling. */
export function HomeGrid({ widgets, version, heading, children }: { widgets: HomeWidget[]; version: number; heading: ReactNode; children?: ReactNode }) {
  const [order, setOrder] = useState(() => widgets.map(widget => widget.key));
  const [seen, setSeen] = useState(version);
  const [editing, setEditing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState("");
  // Saves run one after another, each with the version the previous one wrote.
  const latest = useRef(version);
  const saving = useRef(Promise.resolve());
  // A saved layout comes back as a new version; it replaces the local order.
  if (seen !== version) { setSeen(version); setOrder(widgets.map(widget => widget.key)); }
  useEffect(() => { latest.current = version; }, [version]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const byKey = new Map(widgets.map(widget => [widget.key, widget]));

  function onDragEnd({ active, over }: DragEndEvent) {
    setDragging(false);
    if (!over || active.id === over.id) return;
    const previous = order;
    const next = arrayMove(order, order.indexOf(String(active.id)), order.indexOf(String(over.id)));
    setOrder(next);
    setNotice("");
    saving.current = saving.current.then(async () => {
      try { latest.current = await moveDashboardWidgets(latest.current, next); }
      catch { setOrder(previous); setNotice("Could not save the new order. Reload and try again."); }
    });
  }

  return <>
    <header className="mb-2 flex flex-wrap items-end justify-between gap-4">
      {heading}
      <button type="button" onClick={() => setEditing(!editing)} aria-pressed={editing} className="inline-flex h-11 items-center gap-2 rounded-xl border border-input px-4 text-[13px] hover:bg-muted">
        {editing ? <Check className="size-4" strokeWidth={1.6} aria-hidden="true" /> : <LayoutGrid className="size-4" strokeWidth={1.6} aria-hidden="true" />}{editing ? "Done" : "Edit layout"}
      </button>
    </header>
    {children}
    {editing && <p className="text-sm text-muted-foreground">Drag a card by the handle on its top edge. <Link href="/settings#home" className="text-brand underline">Show or hide cards</Link></p>}
    {notice && <p role="alert" className="text-sm text-danger">{notice}</p>}
    <DndContext id="home-grid" sensors={sensors} collisionDetection={underPointer} onDragStart={() => setDragging(true)} onDragCancel={() => setDragging(false)} onDragEnd={onDragEnd}>
      <SortableContext items={order} strategy={stayPut}>
        {/* Artifact frames would swallow the pointer mid-drag. */}
        <div className={`grid grid-flow-dense gap-4 lg:grid-cols-6 ${dragging ? "select-none [&_iframe]:pointer-events-none" : ""}`}>
          {order.flatMap(key => { const widget = byKey.get(key); return widget ? [<Card key={key} widget={widget} editing={editing} />] : []; })}
        </div>
      </SortableContext>
    </DndContext>
  </>;
}
