import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'icon';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
}

export function Button({ className, variant = 'secondary', size = 'md', ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-[10px] border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-55',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)]',
        size === 'sm' && 'h-8 px-3 text-xs',
        size === 'md' && 'h-10 px-4 text-sm',
        size === 'icon' && 'h-9 w-9 p-0',
        variant === 'primary' && 'border-[var(--primary)] bg-[var(--primary)] text-white hover:bg-[var(--primary-hover)]',
        variant === 'secondary' &&
          'border-[var(--border)] bg-[var(--surface)] text-[var(--fg)] hover:border-[var(--primary)] hover:bg-[var(--primary-ghost)] hover:text-[var(--primary)]',
        variant === 'ghost' && 'border-transparent bg-transparent text-[var(--muted)] hover:bg-[var(--primary-ghost)] hover:text-[var(--fg)]',
        variant === 'danger' &&
          'border-[color-mix(in_oklch,var(--danger)_24%,var(--border))] bg-[var(--danger-ghost)] text-[var(--danger)] hover:border-[var(--danger)]',
        className,
      )}
      type="button"
      {...props}
    />
  );
}

interface FieldProps {
  readonly label: string;
  readonly hint?: string;
  readonly children: ReactNode;
}

export function Field({ label, hint, children }: FieldProps) {
  return (
    <label className="grid gap-1.5">
      <span className="text-xs font-semibold text-[var(--muted)]">{label}</span>
      {children}
      {hint ? <span className="text-[11px] leading-5 text-[var(--muted)]">{hint}</span> : null}
    </label>
  );
}

export function TextInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-10 w-full rounded-[10px] border border-[var(--border)] bg-[var(--bg)] px-3 text-sm text-[var(--fg)] outline-none transition-colors',
        'placeholder:text-[color-mix(in_oklch,var(--muted)_70%,transparent)] focus:border-[var(--primary)]',
        className,
      )}
      {...props}
    />
  );
}

export function SelectInput({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        'h-10 w-full rounded-[10px] border border-[var(--border)] bg-[var(--bg)] px-3 text-sm text-[var(--fg)] outline-none transition-colors',
        'focus:border-[var(--primary)]',
        className,
      )}
      {...props}
    />
  );
}

interface CardProps {
  readonly title?: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}

export function Card({ title, action, children, className }: CardProps) {
  return (
    <section className={cn('rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-sm)]', className)}>
      {title || action ? (
        <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
          {title ? <h2 className="text-sm font-semibold text-[var(--fg)]">{title}</h2> : <span />}
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

interface ToggleProps {
  readonly checked: boolean;
  readonly label: string;
  readonly onChange: (checked: boolean) => void;
}

export function Toggle({ checked, label, onChange }: ToggleProps) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 text-sm font-medium text-[var(--fg)]">
      <span>{label}</span>
      <input
        checked={checked}
        className="peer sr-only"
        onChange={(event) => onChange(event.currentTarget.checked)}
        type="checkbox"
      />
      <span className="toggle-track">
        <span className="toggle-thumb" />
      </span>
    </label>
  );
}
