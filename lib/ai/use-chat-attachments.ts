"use client";

import { useState } from "react";
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, type ChatAttachment } from "./chat-attachments";

type Item = { id: string; name: string; preview?: string; file?: ChatAttachment; error?: string };

/** Phone photos are large; a 2000px JPEG keeps receipts readable and well under the upload limit. */
async function shrink(file: File): Promise<Blob> {
  if (!file.type.startsWith("image/") || file.type === "image/gif") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Could not read photo")), "image/jpeg", 0.85));
  } catch { return file; }
}

/** Files picked in the composer upload straight away; sending passes only the finished ones. */
export function useChatAttachments() {
  const [items, setItems] = useState<Item[]>([]);
  const update = (id: string, patch: Partial<Item>) => setItems(current => current.map(item => item.id === id ? { ...item, ...patch } : item));

  function add(files: FileList | File[]) {
    const picked = [...files].slice(0, Math.max(0, MAX_ATTACHMENTS - items.length));
    for (const file of picked) {
      const id = crypto.randomUUID();
      setItems(current => [...current, { id, name: file.name, preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined }]);
      void (async () => {
        try {
          const blob = await shrink(file);
          if (blob.size > MAX_ATTACHMENT_BYTES) throw new Error("Files must be under 4 MB");
          const form = new FormData();
          form.set("file", blob, blob === file ? file.name : file.name.replace(/\.\w+$/, "") + ".jpg");
          const response = await fetch("/api/chat/attachments", { method: "POST", body: form });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.error ?? "Upload failed");
          update(id, { file: { ...body, name: file.name.slice(0, 200) || body.name } });
        } catch (cause) { update(id, { error: cause instanceof Error ? cause.message : "Upload failed" }); }
      })();
    }
  }
  function remove(id: string) {
    setItems(current => { const item = current.find(entry => entry.id === id); if (item?.preview) URL.revokeObjectURL(item.preview); return current.filter(entry => entry.id !== id); });
  }
  const ready = items.flatMap(item => item.file ? [item.file] : []);
  function clear() { for (const item of items) if (item.preview) URL.revokeObjectURL(item.preview); setItems([]); }
  /** Puts files back after a send that did not go through. */
  function restore(files: ChatAttachment[]) { setItems(current => current.length ? current : files.map(file => ({ id: crypto.randomUUID(), name: file.name, file }))); }
  return { items, add, remove, clear, restore, ready, uploading: items.some(item => !item.file && !item.error), full: items.length >= MAX_ATTACHMENTS };
}
export type ChatAttachments = ReturnType<typeof useChatAttachments>;
