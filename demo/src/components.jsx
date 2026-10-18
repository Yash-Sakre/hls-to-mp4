import { useState } from 'react';

export const Card = ({ title, aside, children, className = '' }) => (
  <section className={`card ${className}`}>
    {(title || aside) && (
      <header className="card-head">
        {title && <h2>{title}</h2>}
        {aside}
      </header>
    )}
    {children}
  </section>
);

export const Field = ({ label, hint, children }) => (
  <label className="field">
    <span className="field-label">{label}</span>
    {children}
    {hint && <span className="field-hint">{hint}</span>}
  </label>
);

export const Segmented = ({ value, onChange, options, label }) => (
  <div className="segmented" role="radiogroup" aria-label={label}>
    {options.map((option) => (
      <button
        key={option.value}
        type="button"
        role="radio"
        aria-checked={value === option.value}
        className={value === option.value ? 'active' : ''}
        disabled={option.disabled}
        title={option.title}
        onClick={() => onChange(option.value)}
      >
        {option.label}
      </button>
    ))}
  </div>
);

export const ProgressBar = ({ ratio, indeterminate }) => (
  <div className={`bar ${indeterminate ? 'indeterminate' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ratio * 100)}>
    <div className="bar-fill" style={{ width: `${Math.round(ratio * 100)}%` }} />
  </div>
);

export const Facts = ({ items }) => (
  <dl className="facts">
    {items
      .filter(([, value]) => value !== null && value !== undefined && value !== false)
      .map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
  </dl>
);

export const CodeBlock = ({ code }) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="code">
      <button type="button" className="ghost small" onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
};

export const Badge = ({ tone = 'neutral', children }) => <span className={`badge ${tone}`}>{children}</span>;
