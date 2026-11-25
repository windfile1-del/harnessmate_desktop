import { AlertTriangle, Check, XCircle } from 'lucide-react';
import { useState } from 'react';
import { validateElicitationDraft } from './selectors';
import type { NativeElicitationFieldView, NativeElicitationFormSpecView } from './types';

export interface NativeElicitationFormProps {
  readonly approvalId: string;
  readonly formSpec: NativeElicitationFormSpecView;
  readonly canAnswer: boolean;
  readonly canCancel: boolean;
  readonly submitting: boolean;
  readonly onSubmitForm: (formPayload: Record<string, string | number | boolean | string[]>) => void;
  readonly onDecline?: () => void;
  readonly onCancel: () => void;
}

function buildInitialDraft(
  fields: readonly NativeElicitationFieldView[],
): Record<string, string | number | boolean | string[] | undefined> {
  const draft: Record<string, string | number | boolean | string[] | undefined> = {};
  for (const field of fields) {
    if (field.defaultValue !== undefined) {
      draft[field.name] =
        typeof field.defaultValue === 'object'
          ? [...field.defaultValue]
          : field.defaultValue;
    } else if (field.type === 'boolean') {
      draft[field.name] = false;
    } else if (field.type === 'string_array') {
      draft[field.name] = [];
    }
  }
  return draft;
}

/**
 * Schema-validated ACP v1 Elicitation Form component.
 *
 * Strictly renders only verified flat field types (`string`, `enum`, `number`, `integer`,
 * `boolean`, `string_array`). When the schema is unsupported (e.g. URL mode or nested object
 * fields), renders an explicit unsupported notice and exposes only decline/cancel.
 */
export function NativeElicitationForm({
  approvalId,
  formSpec,
  canAnswer,
  canCancel,
  submitting,
  onSubmitForm,
  onDecline,
  onCancel,
}: NativeElicitationFormProps) {
  const [draft, setDraft] = useState<Record<string, string | number | boolean | string[] | undefined>>(
    () => buildInitialDraft(formSpec.fields),
  );
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});

  if (!formSpec.supported || !canAnswer) {
    return (
      <div
        data-testid="native-elicitation-unsupported"
        className="space-y-2 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-2.5 text-[11.5px]"
      >
        <div className="flex items-start gap-2 text-[var(--accent-clay)]">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <div className="font-medium">当前原生表单无法在协议中编码提交</div>
            <p className="mt-0.5 text-[11px] text-[var(--text-secondary)]">
              原因：{formSpec.unsupportedReason ?? '未声明受支持的表单字段或目标未确认'}。不会隐式代填或映射到默认选项。
            </p>
          </div>
        </div>
        {canCancel && (
          <div className="flex justify-end gap-1.5">
            {onDecline && (
              <button
                type="button"
                disabled={submitting}
                onClick={onDecline}
                className="cursor-pointer rounded-lg border border-[var(--border-hairline)] px-2.5 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-45"
              >
                拒绝
              </button>
            )}
            <button
              type="button"
              disabled={submitting}
              onClick={onCancel}
              className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] px-2.5 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-45"
            >
              <XCircle size={11.5} aria-hidden="true" />
              <span>取消请求</span>
            </button>
          </div>
        )}
      </div>
    );
  }

  const handleSubmit = () => {
    if (submitting) return;
    const errors = validateElicitationDraft(formSpec, draft);
    setValidationErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const cleanPayload: Record<string, string | number | boolean | string[]> = {};
    for (const field of formSpec.fields) {
      const value = draft[field.name];
      if (value !== undefined && value !== '') {
        cleanPayload[field.name] = value;
      }
    }
    onSubmitForm(cleanPayload);
  };

  return (
    <div data-testid="native-elicitation-form" className="space-y-2.5">
      <div className="space-y-2">
        {formSpec.fields.map((field) => {
          const inputId = `elicit-${approvalId}-${field.name}`;
          const err = validationErrors[field.name];
          const value = draft[field.name];

          return (
            <div key={field.name} className="space-y-1">
              <label
                htmlFor={inputId}
                className="flex items-center gap-1 text-[11.5px] font-medium text-[var(--text-primary)]"
              >
                <span>{field.title ?? field.name}</span>
                {field.required && <span className="text-[var(--accent-rose)]">*</span>}
              </label>
              {field.description && (
                <p className="text-[10.5px] text-[var(--text-muted)]">{field.description}</p>
              )}

              {field.type === 'boolean' ? (
                <label className="inline-flex cursor-pointer items-center gap-2 text-[11.5px] text-[var(--text-secondary)]">
                  <input
                    id={inputId}
                    type="checkbox"
                    checked={Boolean(value)}
                    disabled={submitting}
                    onChange={(e) =>
                      setDraft((prev) => ({ ...prev, [field.name]: e.target.checked }))
                    }
                  />
                  <span>{Boolean(value) ? '是' : '否'}</span>
                </label>
              ) : field.type === 'string' && field.enum && field.enum.length > 0 ? (
                <select
                  id={inputId}
                  value={typeof value === 'string' ? value : ''}
                  disabled={submitting}
                  onChange={(e) =>
                    setDraft((prev) => ({ ...prev, [field.name]: e.target.value || undefined }))
                  }
                  className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-[12px] text-[var(--text-primary)]"
                >
                  <option value="">请选择...</option>
                  {field.enum.map((optVal, idx) => (
                    <option key={optVal} value={optVal}>
                      {field.enumNames?.[idx] ?? optVal}
                    </option>
                  ))}
                </select>
              ) : field.type === 'string_array' && field.enum && field.enum.length > 0 ? (
                <div className="space-y-1" role="group" aria-label={field.title ?? field.name}>
                  {field.enum.map((optVal) => {
                    const selected = Array.isArray(value) ? value : [];
                    const checked = selected.includes(optVal);
                    return (
                      <label
                        key={optVal}
                        className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2.5 py-1 text-[11.5px]"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={submitting}
                          onChange={() => {
                            const next = checked
                              ? selected.filter((item) => item !== optVal)
                              : [...selected, optVal];
                            setDraft((prev) => ({ ...prev, [field.name]: next }));
                          }}
                        />
                        <span className="text-[var(--text-primary)]">{optVal}</span>
                      </label>
                    );
                  })}
                </div>
              ) : field.type === 'number' || field.type === 'integer' ? (
                <input
                  id={inputId}
                  type="number"
                  step={field.type === 'integer' ? '1' : 'any'}
                  min={field.minimum}
                  max={field.maximum}
                  value={typeof value === 'number' ? String(value) : ''}
                  disabled={submitting}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (raw === '') {
                      setDraft((prev) => ({ ...prev, [field.name]: undefined }));
                    } else {
                      const num = Number(raw);
                      setDraft((prev) => ({
                        ...prev,
                        [field.name]: Number.isFinite(num) ? num : undefined,
                      }));
                    }
                  }}
                  className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2.5 py-1.5 font-mono-code text-[12px] text-[var(--text-primary)]"
                />
              ) : (
                <input
                  id={inputId}
                  type={field.format === 'email' ? 'email' : field.format === 'date' ? 'date' : 'text'}
                  value={typeof value === 'string' ? value : ''}
                  disabled={submitting}
                  placeholder={field.description ?? `输入 ${field.title ?? field.name}`}
                  onChange={(e) =>
                    setDraft((prev) => ({ ...prev, [field.name]: e.target.value }))
                  }
                  className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-[12px] text-[var(--text-primary)]"
                />
              )}

              {err && (
                <p role="alert" className="text-[11px] text-[var(--accent-rose)]">
                  {err}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {validationErrors._form && (
        <p role="alert" className="text-[11px] text-[var(--accent-rose)]">
          {validationErrors._form}
        </p>
      )}

      <div className="flex flex-wrap justify-end gap-1.5">
        {onDecline && (
          <button
            type="button"
            disabled={submitting}
            onClick={onDecline}
            className="cursor-pointer rounded-lg border border-[var(--border-hairline)] px-2.5 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-45"
          >
            拒绝
          </button>
        )}
        <button
          type="button"
          disabled={submitting || !canCancel}
          onClick={onCancel}
          className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] px-2.5 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-45"
        >
          <XCircle size={11.5} aria-hidden="true" />
          <span>取消</span>
        </button>
        <button
          type="button"
          disabled={submitting}
          onClick={handleSubmit}
          className="inline-flex cursor-pointer items-center gap-1 rounded-lg bg-[var(--accent-indigo)] px-3 py-1 text-[11px] font-medium text-white disabled:opacity-45"
        >
          <Check size={11.5} aria-hidden="true" />
          <span>提交表单</span>
        </button>
      </div>
    </div>
  );
}
