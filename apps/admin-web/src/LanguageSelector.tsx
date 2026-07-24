import { Languages } from "lucide-react";

import { normalizeLocale, supportedLocales, useAdminI18n } from "./i18n";

export function LanguageSelector({
  placement,
}: {
  readonly placement: "rail" | "utility";
}): React.JSX.Element {
  const { locale, messages, setLocale } = useAdminI18n();

  return (
    <label className={`language-selector language-selector--${placement}`}>
      <Languages aria-hidden="true" />
      <span className="sr-only">{messages.common.language}</span>
      <select
        aria-label={messages.common.language}
        onChange={(event) => {
          const nextLocale = normalizeLocale(event.currentTarget.value);
          if (nextLocale !== null) {
            setLocale(nextLocale);
          }
        }}
        value={locale}
      >
        {supportedLocales.map((option) => (
          <option key={option.code} lang={option.code} value={option.code}>
            {option.name}
          </option>
        ))}
      </select>
    </label>
  );
}
