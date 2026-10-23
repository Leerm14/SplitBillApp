/**
 * Centralized design system / theme for SplitBill app.
 * All screens should reference these tokens for consistency.
 */

export const Colors = {
  // Primary palette — warm teal / emerald
  primary: '#0D9488',       // teal-600
  primaryDark: '#0F766E',   // teal-700
  primaryLight: '#CCFBF1',  // teal-100
  primaryMuted: '#99F6E4',  // teal-200

  // Accent — warm amber for highlights / CTAs
  accent: '#F59E0B',        // amber-500
  accentDark: '#D97706',    // amber-600
  accentLight: '#FEF3C7',   // amber-100

  // Semantic
  success: '#10B981',       // emerald-500
  successLight: '#D1FAE5',  // emerald-100
  successDark: '#059669',   // emerald-600
  danger: '#EF4444',        // red-500
  dangerLight: '#FEE2E2',   // red-100
  dangerDark: '#DC2626',    // red-600
  warning: '#F59E0B',       // amber-500
  warningLight: '#FEF3C7',  // amber-100
  warningDark: '#B45309',   // amber-700
  info: '#3B82F6',          // blue-500
  infoLight: '#DBEAFE',     // blue-100

  // Neutrals
  text: '#111827',          // gray-900
  textSecondary: '#6B7280', // gray-500
  textTertiary: '#9CA3AF',  // gray-400
  textInverse: '#FFFFFF',

  background: '#F9FAFB',    // gray-50
  surface: '#FFFFFF',
  surfaceElevated: '#FFFFFF',
  border: '#E5E7EB',        // gray-200
  borderLight: '#F3F4F6',   // gray-100
  divider: '#E5E7EB',

  // Overlays
  overlay: 'rgba(0,0,0,0.5)',
  shadow: '#000000',
} as const;

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

export const Radii = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  full: 999,
} as const;

export const FontSizes = {
  xs: 11,
  sm: 13,
  md: 15,
  lg: 17,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  hero: 40,
} as const;

export const FontWeights = {
  regular: '400' as const,
  medium: '500' as const,
  semibold: '600' as const,
  bold: '700' as const,
  extrabold: '800' as const,
};

/** Consistent shadow presets */
export const Shadows = {
  sm: {
    shadowColor: Colors.shadow,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  md: {
    shadowColor: Colors.shadow,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
  },
  lg: {
    shadowColor: Colors.shadow,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
    elevation: 6,
  },
  colored: (color: string) => ({
    shadowColor: color,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  }),
} as const;

