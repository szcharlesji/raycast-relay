import { FlatCompat } from "@eslint/eslintrc";
import js from "@eslint/js";
import tseslint from "typescript-eslint";

const compat = new FlatCompat();

export default tseslint.config(
  js.configs.recommended,
  ...compat.extends("plugin:@typescript-eslint/recommended"),
);
