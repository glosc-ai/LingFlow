import { Children, isValidElement, useEffect, useMemo, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, ChangeEvent, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
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

interface SelectOption {
  readonly disabled: boolean;
  readonly label: ReactNode;
  readonly text: string;
  readonly value: string;
}

export function SelectInput({ children, className, disabled, onChange, value, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedValue = value == null ? '' : String(value);
  const options = useMemo(
    () =>
      Children.toArray(children)
        .filter(isValidElement)
        .map((child) => {
          const optionProps = child.props as { children?: ReactNode; disabled?: boolean; value?: string | number };
          const optionValue = optionProps.value == null ? '' : String(optionProps.value);
          return {
            disabled: Boolean(optionProps.disabled),
            label: optionProps.children,
            text: optionText(optionProps.children),
            value: optionValue,
          } satisfies SelectOption;
        }),
    [children],
  );
  const selectedOption = options.find((option) => option.value === selectedValue) ?? options[0];

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    function closeOnOutside(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    }

    document.addEventListener('pointerdown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  function selectOption(option: SelectOption) {
    if (disabled || option.disabled) {
      return;
    }

    setOpen(false);
    if (option.value !== selectedValue) {
      onChange?.({
        currentTarget: { value: option.value },
        target: { value: option.value },
      } as ChangeEvent<HTMLSelectElement>);
    }
  }

  return (
    <div className={cn('relative w-full', className)} ref={rootRef}>
      <button
        aria-expanded={open}
        className={cn(
          'flex h-10 w-full items-center justify-between gap-3 rounded-[10px] border border-[var(--border)] bg-[var(--bg)] px-3 text-left text-sm text-[var(--fg)] outline-none transition-colors',
          'focus:border-[var(--primary)] disabled:cursor-not-allowed disabled:opacity-55',
        )}
        disabled={disabled}
        onClick={(event) => {
          event.preventDefault();
          setOpen((current) => !current);
        }}
        type="button"
        {...buttonAriaProps(props)}
      >
        <span className="min-w-0 flex-1 truncate">{selectedOption?.label ?? selectedValue}</span>
        <span className={cn('h-0 w-0 border-x-[5px] border-t-[6px] border-x-transparent border-t-[var(--muted)] transition-transform', open && 'rotate-180')} />
      </button>
      {open ? (
        <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-50 max-h-64 overflow-y-auto rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-1 shadow-[var(--shadow-md)]">
          {options.map((option) => (
            <button
              className={cn(
                'flex min-h-9 w-full items-center rounded-[8px] px-3 text-left text-sm text-[var(--fg)] transition-colors',
                'hover:bg-[var(--primary-ghost)] hover:text-[var(--primary)]',
                option.value === selectedValue && 'bg-[var(--primary-ghost)] text-[var(--primary)]',
                option.disabled && 'cursor-not-allowed opacity-45 hover:bg-transparent hover:text-[var(--fg)]',
              )}
              disabled={option.disabled}
              key={`${option.value}-${option.text}`}
              onClick={(event) => {
                event.preventDefault();
                selectOption(option);
              }}
              type="button"
            >
              <span className="min-w-0 truncate">{option.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function optionText(value: ReactNode): string {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(optionText).join('');
  }
  return '';
}

function buttonAriaProps(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { 'aria-label': ariaLabel, 'aria-labelledby': ariaLabelledBy, id, name, title } = props;
  return { 'aria-label': ariaLabel, 'aria-labelledby': ariaLabelledBy, id, name, title };
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
