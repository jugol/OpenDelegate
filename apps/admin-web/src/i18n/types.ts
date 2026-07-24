import type { englishMessages } from "./messages.en";

export type Messages = {
  readonly [Section in keyof typeof englishMessages]: {
    readonly [Key in keyof (typeof englishMessages)[Section]]: string;
  };
};

export type SupportedLocale = "en" | "es" | "fr" | "ja" | "ko" | "zh-CN";

export type KnownTextKey = keyof Messages["known"];
