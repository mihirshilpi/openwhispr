import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, FolderOpen, Send } from "../icons";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { useSettingsStore } from "../../stores/settingsStore";
import type { MeetingFrame } from "../../types/electron";
import { cn } from "../lib/utils";

function formatOffset(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// Screenshots are read over IPC as data URLs, one at a time as each thumbnail
// scrolls into view, so a long meeting never loads every image at once.
function useFrameImage(noteId: number, file: string | null, enabled: boolean) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled || !file) return;
    let cancelled = false;
    window.electronAPI?.readMeetingFrame?.(noteId, file).then((url) => {
      if (!cancelled) setSrc(url);
    });
    return () => {
      cancelled = true;
    };
  }, [noteId, file, enabled]);
  return src;
}

function Thumbnail({
  noteId,
  frame,
  onOpen,
}: {
  noteId: number;
  frame: MeetingFrame;
  onOpen: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || visible) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
      },
      { rootMargin: "200px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);
  const src = useFrameImage(noteId, frame.file, visible);

  return (
    <button
      ref={ref}
      type="button"
      onClick={onOpen}
      className="group relative h-20 w-36 shrink-0 overflow-hidden rounded-md border border-border/60 bg-muted/40 outline-none focus-visible:ring-1 focus-visible:ring-ring/40"
    >
      {src && (
        <img
          src={src}
          alt=""
          aria-hidden="true"
          width={144}
          height={80}
          decoding="async"
          draggable={false}
          className="h-full w-full object-cover transition-opacity group-hover:opacity-90"
        />
      )}
      <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1 text-[10px] font-medium text-white tabular-nums">
        {formatOffset(frame.offsetMs)}
      </span>
    </button>
  );
}

function FrameViewer({
  noteId,
  frames,
  index,
  onIndexChange,
  onClose,
}: {
  noteId: number;
  frames: MeetingFrame[];
  index: number | null;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const frame = index != null ? frames[index] : null;
  const src = useFrameImage(noteId, frame?.file ?? null, frame != null);

  const step = useCallback(
    (delta: number) => {
      if (index == null) return;
      onIndexChange(Math.min(frames.length - 1, Math.max(0, index + delta)));
    },
    [index, frames.length, onIndexChange]
  );

  return (
    <Dialog open={frame != null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="sm:max-w-5xl p-3 gap-2"
        aria-describedby={undefined}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") step(-1);
          if (e.key === "ArrowRight") step(1);
        }}
      >
        <DialogTitle className="text-sm font-medium">
          {frame
            ? t("notes.screenshots.viewerTitle", {
                time: formatOffset(frame.offsetMs),
                index: (index ?? 0) + 1,
                count: frames.length,
              })
            : ""}
        </DialogTitle>
        <div className="flex min-h-64 items-center justify-center rounded-md bg-muted/40">
          {src && (
            <img
              src={src}
              alt={frame ? t("notes.screenshots.alt", { time: formatOffset(frame.offsetMs) }) : ""}
              decoding="async"
              draggable={false}
              className="max-h-[70vh] w-full object-contain"
            />
          )}
        </div>
        <div className="flex justify-between">
          <Button variant="ghost" size="sm" onClick={() => step(-1)} disabled={!index}>
            <ChevronLeft className="size-4" />
            {t("notes.screenshots.previous")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => step(1)}
            disabled={index == null || index >= frames.length - 1}
          >
            {t("notes.screenshots.next")}
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// The screenshots taken during a meeting, above its transcript. Each one is
// labelled with the time into the meeting it was taken, the same clock as the
// transcript.
export function MeetingScreenshots({ noteId, className }: { noteId: number; className?: string }) {
  const { t } = useTranslation();
  const [frames, setFrames] = useState<MeetingFrame[]>([]);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [sent, setSent] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const hookUrl = useSettingsStore((s) => s.meetingFinishedWebhookUrl);
  const hookCommand = useSettingsStore((s) => s.meetingFinishedCommand);
  const hookConfigured = Boolean(hookUrl.trim() || hookCommand.trim());

  useEffect(() => {
    let cancelled = false;
    setFrames([]);
    setOpenIndex(null);
    setSent("idle");
    window.electronAPI?.listMeetingFrames?.(noteId).then((result) => {
      if (!cancelled) setFrames(result?.frames ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [noteId]);

  const sendToAgent = useCallback(async () => {
    setSent("sending");
    try {
      const result = await window.electronAPI?.runMeetingFinishedHookNow?.({
        noteId,
        url: hookUrl,
        command: hookCommand,
      });
      setSent(result?.success ? "sent" : "failed");
    } catch {
      setSent("failed");
    }
  }, [noteId, hookUrl, hookCommand]);

  if (frames.length === 0) return null;

  return (
    <div className={cn("px-5 pt-3", className)}>
      <div className="mb-2 flex items-center gap-2">
        <p className="flex-1 text-xs font-medium text-foreground/60">
          {t("notes.screenshots.title", { count: frames.length })}
        </p>
        {hookConfigured && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={sendToAgent}
            disabled={sent === "sending"}
          >
            <Send className="size-3.5" />
            {t(`notes.screenshots.send.${sent}`)}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={() => window.electronAPI?.openMeetingFramesFolder?.(noteId)}
        >
          <FolderOpen className="size-3.5" />
          {t("notes.screenshots.openFolder")}
        </Button>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-2">
        {frames.map((frame, index) => (
          <Thumbnail
            key={frame.file}
            noteId={noteId}
            frame={frame}
            onOpen={() => setOpenIndex(index)}
          />
        ))}
      </div>
      <FrameViewer
        noteId={noteId}
        frames={frames}
        index={openIndex}
        onIndexChange={setOpenIndex}
        onClose={() => setOpenIndex(null)}
      />
    </div>
  );
}
