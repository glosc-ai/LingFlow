import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly label: string;
}

export function IconButton({ children, className, label, ...props }: IconButtonProps) {
  return (
    <button aria-label={label} className={cn('icon-button', className)} title={label} type="button" {...props}>
      {children}
    </button>
  );
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: 'primary' | 'ghost';
  readonly block?: boolean;
}

export function Button({ block, className, variant = 'ghost', ...props }: ButtonProps) {
  return (
    <button
      className={cn('popup-button', variant === 'primary' && 'primary', block && 'w-full', className)}
      type="button"
      {...props}
    />
  );
}

export function Toggle({
  checked,
  label,
  onChange,
}: {
  readonly checked: boolean;
  readonly label: string;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <label className="toggle-row">
      <span className="toggle-label">{label}</span>
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

export function Field({ children, label }: { readonly children: ReactNode; readonly label: string }) {
  return (
    <label className="grid gap-1.5">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

export function SelectField({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn('select-field', className)} {...props} />;
}

export function TextField({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn('input-field', className)} {...props} />;
}

export function Section({ children, title }: { readonly children: ReactNode; readonly title: string }) {
  return (
    <section>
      <h2 className="section-title">{title}</h2>
      {children}
    </section>
  );
}
