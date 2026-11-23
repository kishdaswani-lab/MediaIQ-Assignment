"use client";

import {
  createContext,
  useContext,
  useState,
  type ReactNode,
} from "react";

type ViewMode = "guided" | "advanced";

const ViewModeContext = createContext<{
  mode: ViewMode;
  setMode: (mode: ViewMode) => void;
} | null>(null);

export function ViewModeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ViewMode>("guided");

  return (
    <ViewModeContext.Provider value={{ mode, setMode }}>
      {children}
    </ViewModeContext.Provider>
  );
}

function useViewMode() {
  const context = useContext(ViewModeContext);

  if (!context) {
    throw new Error("View mode controls must render inside ViewModeProvider.");
  }

  return context;
}

export function ViewModeToggle() {
  const { mode, setMode } = useViewMode();

  return (
    <div
      className="inline-flex rounded-full border border-line bg-white p-1 shadow-sm"
      role="group"
      aria-label="Presentation mode"
    >
      <ModeButton
        label="Guided View"
        pressed={mode === "guided"}
        onClick={() => setMode("guided")}
      />
      <ModeButton
        label="Advanced View"
        pressed={mode === "advanced"}
        onClick={() => setMode("advanced")}
      />
    </div>
  );
}

function ModeButton({
  label,
  pressed,
  onClick,
}: {
  label: string;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
        pressed
          ? "bg-navy text-white"
          : "text-muted hover:text-ink"
      }`}
    >
      {label}
    </button>
  );
}

export function Presentation({
  guided,
  advanced,
}: {
  guided: ReactNode;
  advanced: ReactNode;
}) {
  const { mode } = useViewMode();

  return mode === "advanced" ? advanced : guided;
}
