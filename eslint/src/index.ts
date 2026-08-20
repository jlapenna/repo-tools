import {
  fleetBaseline,
  FLEET_RESTRICTED_SYNTAX,
  FLEET_UNUSED_VARS_OPTIONS,
} from './fleet-baseline.mjs';
import {
  rule as noServerOnlyImportsInClient,
  RULE_NAME as noServerOnlyImportsInClientName,
} from './rules/no-server-only-imports-in-client';
import {
  rule as useServerActionsOnly,
  RULE_NAME as useServerActionsOnlyName,
} from './rules/use-server-actions-only';

/**
 * The fleet-owned rules. Consumers register this object under their chosen
 * ESLint plugin namespace, then enable the exported rule names in config.
 */
export const fleetEslintPlugin = Object.freeze({
  rules: {
    [noServerOnlyImportsInClientName]: noServerOnlyImportsInClient,
    [useServerActionsOnlyName]: useServerActionsOnly,
  },
});

export {
  fleetBaseline,
  FLEET_RESTRICTED_SYNTAX,
  FLEET_UNUSED_VARS_OPTIONS,
  noServerOnlyImportsInClientName,
  useServerActionsOnlyName,
};
