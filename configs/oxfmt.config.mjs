// Shared oxfmt options carrying the old Prettier intent. Consumers re-export
// from an auto-discovered `oxfmt.config.ts`:  export { default } from '@gingur-root/devkit/oxfmt';
export default {
  printWidth: 100,
  singleQuote: true,
  semi: true,
  trailingComma: 'all',
  // ON by default in oxfmt — disabled to avoid surprise package.json churn; revisit later.
  sortPackageJson: false,
};
