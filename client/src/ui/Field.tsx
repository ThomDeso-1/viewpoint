import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  type ReactNode,
} from 'react';

/**
 * One form-field system. `Field` is the label + help + inline-error
 * wrapper; `Input` / `Select` / `Textarea` are the styled controls.
 * `TextField` bundles the common case. Errors render inline under the
 * control, not as a banner at the top of the form.
 */

interface FieldProps {
  label?: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}

export function Field({ label, help, error, htmlFor, children, className }: FieldProps) {
  return (
    <div className={['vp-field', error && 'is-error', className].filter(Boolean).join(' ')}>
      {label != null && (
        <label className="vp-field-label" htmlFor={htmlFor}>
          {label}
        </label>
      )}
      {children}
      {error != null ? (
        <p className="vp-field-msg" role="alert">
          {error}
        </p>
      ) : (
        help != null && <p className="vp-field-help">{help}</p>
      )}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={['vp-input', className].filter(Boolean).join(' ')} {...rest} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <select ref={ref} className={['vp-input vp-select', className].filter(Boolean).join(' ')} {...rest}>
        {children}
      </select>
    );
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return (
      <textarea ref={ref} className={['vp-input vp-textarea', className].filter(Boolean).join(' ')} {...rest} />
    );
  },
);

type TextFieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label?: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
};

export function TextField({ label, help, error, id, ...rest }: TextFieldProps) {
  const auto = useId();
  const fieldId = id ?? auto;
  return (
    <Field label={label} help={help} error={error} htmlFor={fieldId}>
      <Input id={fieldId} aria-invalid={error ? true : undefined} {...rest} />
    </Field>
  );
}
