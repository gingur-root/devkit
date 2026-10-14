// Shared oxfmt options carrying the old Prettier intent, used by configs/vite.mjs.
export default {
  printWidth: 100,
  singleQuote: true,
  semi: true,
  trailingComma: 'all',
  // ON by default in oxfmt — disabled to avoid surprise package.json churn; revisit later.
  sortPackageJson: false,
};
