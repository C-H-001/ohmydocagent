import React, { useEffect, useState } from "react"
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export const Button =
  React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: "primary" | "secondary" | "ghost" | "outline"
    size?: "sm" | "md" | "lg" | "icon"
  }>(({ className, variant = "primary", size = "md", ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(
          "inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50 disabled:pointer-events-none",
          {
            "bg-primary text-primary-foreground hover:bg-primary/90":
              variant === "primary",
            "bg-muted text-foreground hover:bg-muted/80":
              variant === "secondary",
            "hover:bg-muted hover:text-foreground text-muted-foreground":
              variant === "ghost",
            "border border-border bg-transparent hover:bg-muted text-foreground":
              variant === "outline",
            "h-9 px-3": size === "sm",
            "h-10 py-2 px-4": size === "md",
            "h-11 px-8": size === "lg",
            "h-10 w-10": size === "icon",
          },
          className,
        )}
        {...props}
      />
    )
  })
Button.displayName = "Button"

export const Input =
  React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
    ({ className, ...props }, ref) => {
      return (
        <input
          ref={ref}
          className={cn(
            "flex h-10 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
          {...props}
        />
      )
    },
  )
Input.displayName = "Input"

export const Card = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "rounded-lg border border-border bg-card text-card-foreground shadow-sm",
      className,
    )}
    {...props}
  />
)
export const CardHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col space-y-1.5 p-6", className)} {...props} />
)
export const CardTitle = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>) => (
  <h3
    className={cn(
      "text-lg font-semibold leading-none tracking-tight",
      className,
    )}
    {...props}
  />
)
export const CardContent = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("p-6 pt-0", className)} {...props} />
)
export const Badge = ({
  className,
  variant = "default",
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  variant?: "default" | "secondary" | "outline"
}) => (
  <div
    className={cn(
      "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
      variant === "default" &&
        "border-transparent bg-primary text-primary-foreground",
      variant === "secondary" &&
        "border-transparent bg-muted text-muted-foreground",
      variant === "outline" && "text-foreground",
      className,
    )}
    {...props}
  />
)

export const Dialog = ({
  open,
  onOpenChange,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
}) => {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="fixed inset-0" onClick={() => onOpenChange(false)} />
      <div className="relative z-50 grid w-full max-w-lg gap-4 rounded-lg border border-border bg-card p-6 shadow-lg shadow-black/5 animate-in fade-in-90 zoom-in-95">
        {children}
      </div>
    </div>
  )
}

export const Drawer = ({
  open,
  onOpenChange,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
}) => {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-background/80 backdrop-blur-sm">
      <div className="fixed inset-0" onClick={() => onOpenChange(false)} />
      <div className="relative z-50 flex h-full w-[500px] flex-col border-l border-border bg-card shadow-xl animate-in slide-in-from-right-full">
        {children}
      </div>
    </div>
  )
}

export const Switch = ({
  checked,
  onChange,
}: {
  checked?: boolean
  onChange?: (c: boolean) => void
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    onClick={() => onChange?.(!checked)}
    className={cn(
      "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
      checked ? "bg-primary" : "bg-input bg-muted",
    )}
  >
    <span
      className={cn(
        "pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform",
        checked ? "translate-x-4" : "translate-x-0",
      )}
    />
  </button>
)

// ─── Toast ────────────────────────────────────────────────────────────────────
type ToastType = "success" | "error" | "info"
interface ToastItem { id: number; message: string; type: ToastType }
let toastQueue: ToastItem[] = []
let toastListeners: Array<() => void> = []
let toastSeq = 0

export function toast(message: string, type: ToastType = "success") {
  const id = ++toastSeq
  toastQueue = [...toastQueue, { id, message, type }]
  toastListeners.forEach((l) => l())
  setTimeout(() => {
    toastQueue = toastQueue.filter((t) => t.id !== id)
    toastListeners.forEach((l) => l())
  }, 3200)
}

export function ToastHost() {
  const [, force] = useState(0)
  useEffect(() => {
    const listener = () => force((x) => x + 1)
    toastListeners.push(listener)
    return () => {
      toastListeners = toastListeners.filter((l) => l !== listener)
    }
  }, [])
  return (
    <div className="fixed top-4 right-4 z-[120] flex flex-col gap-2 pointer-events-none">
      {toastQueue.map((t) => (
        <div
          key={t.id}
          className={cn(
            "pointer-events-auto flex items-center gap-2 rounded-lg border bg-card px-4 py-2.5 text-sm shadow-lg animate-in fade-in-90 slide-in-from-top-2",
            t.type === "success" && "border-emerald-200 text-emerald-700",
            t.type === "error" && "border-red-200 text-red-700",
            t.type === "info" && "border-border text-foreground",
          )}
        >
          <span
            className={cn(
              "w-1.5 h-1.5 rounded-full flex-shrink-0",
              t.type === "success" && "bg-emerald-500",
              t.type === "error" && "bg-red-500",
              t.type === "info" && "bg-accent",
            )}
          />
          {t.message}
        </div>
      ))}
    </div>
  )
}

export const Select = ({
  value,
  onChange,
  options,
  placeholder,
}: {
  value?: string
  onChange?: (v: string) => void
  options: { label: string; value: string }[]
  placeholder?: string
}) => (
  <div className="relative">
    <select
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
      className="flex h-9 w-full items-center justify-between rounded-md border border-border bg-transparent px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-50 appearance-none"
    >
      {placeholder && (
        <option value="" disabled>
          {placeholder}
        </option>
      )}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  </div>
)
