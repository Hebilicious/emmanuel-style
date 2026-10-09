import { defineConfig } from "@hebilicious/cssforge"
// The palette is generated for the Astro package, which is still the reference
// build while the two are compared; importing it keeps one source of truth.
import { accents, neutrals } from "../astro/palette.generated"

/**
 * Design tokens for emmanuel.style.
 *
 * Art direction: terminal plus newspaper. Black ink on warm paper, and a
 * terminal's light-on-black at night. That is why the spine of both themes is a
 * neutral ramp while the five coolors anchors are used only for accents, marks
 * and links. See scripts/derive-palette.mjs, which produces
 * palette.generated.ts and asserts every pairing used here against WCAG.
 */

/** cssforge wants `{ hex }` leaves keyed by variant name. */
const palette = (ramp: Record<string, string>) =>
	Object.fromEntries(Object.entries(ramp).map(([step, hex]) => [step, { hex }]))

export default defineConfig({
	typography: {
		fluid: {
			/** Chrome: meta lines, status bars, key hints. */
			micro: {
				value: {
					minWidth: 320,
					maxWidth: 1440,
					minFontSize: 12,
					maxFontSize: 14,
					minTypeScale: 1.2,
					maxTypeScale: 1.2,
					positiveSteps: 1,
					negativeSteps: 1,
					prefix: "font-size-micro"
				}
			},
			/** Reading scale: body copy and article headings. */
			content: {
				value: {
					minWidth: 320,
					maxWidth: 1440,
					minFontSize: 16,
					maxFontSize: 19,
					minTypeScale: 1.2,
					maxTypeScale: 1.25,
					positiveSteps: 3,
					negativeSteps: 1,
					prefix: "font-size"
				}
			},
			/** Display scale: mastheads and titles, larger on wide screens. */
			display: {
				value: {
					minWidth: 320,
					maxWidth: 1800,
					minFontSize: 26,
					maxFontSize: 54,
					minTypeScale: 1.25,
					maxTypeScale: 1.333,
					positiveSteps: 2,
					negativeSteps: 1,
					prefix: "font-size-display"
				}
			}
		},
		weight: {
			body: {
				value: {
					regular: "400",
					medium: "500",
					bold: "700"
				}
			}
		}
	},
	spacing: {
		fluid: {
			/** Vertical rhythm between blocks of content. */
			flow: {
				value: {
					minWidth: 320,
					maxWidth: 1440,
					minSize: 16,
					maxSize: 28,
					negativeSteps: [1],
					positiveSteps: [1.5, 2, 3, 4],
					prefix: "space"
				}
			},
			/** Rhythm inside a block: labels, rows, list items. */
			tight: {
				value: {
					minWidth: 320,
					maxWidth: 1440,
					minSize: 6,
					maxSize: 10,
					negativeSteps: [1],
					positiveSteps: [1.5, 2, 3],
					prefix: "space-tight"
				}
			},
			/** Page gutters, generous on wide screens. */
			gutter: {
				value: {
					minWidth: 320,
					maxWidth: 1600,
					minSize: 16,
					maxSize: 64,
					negativeSteps: [],
					positiveSteps: [1.5, 2],
					prefix: "space-gutter"
				}
			},
			/** Gaps between newspaper columns. */
			column: {
				value: {
					minWidth: 320,
					maxWidth: 1600,
					minSize: 20,
					maxSize: 56,
					negativeSteps: [],
					positiveSteps: [1.5],
					prefix: "space-column"
				}
			}
		},
		custom: {
			size: {
				value: {
					none: "0",
					hairline: "1px",
					rule: "3px"
				}
			}
		}
	},
	colors: {
		palette: {
			value: {
				/** Ink and paper: the spine of both themes. */
				neutral: { value: palette(neutrals) },
				/** The five coolors anchors, expanded. Accents only. */
				aqua: { value: palette(accents.aqua) },
				frost: { value: palette(accents.frost) },
				peri: { value: palette(accents.peri) },
				pink: { value: palette(accents.pink) },
				rose: { value: palette(accents.rose) }
			}
		},
		theme: {
			light: {
				value: {
					colors: {
						value: {
							paper: "var(--palette-neutral-50)",
							ink: "var(--palette-neutral-900)",
							muted: "var(--palette-neutral-600)",
							faint: "var(--palette-neutral-500)",
							rule: "var(--palette-neutral-300)",
							"rule-strong": "var(--palette-neutral-800)",
							surface: "var(--palette-neutral-100)",
							sunk: "var(--palette-neutral-200)",
							accent: "var(--palette-rose-700)",
							"accent-ink": "var(--palette-neutral-0)",
							"accent-soft": "var(--palette-rose-200)",
							secondary: "var(--palette-peri-700)",
							tertiary: "var(--palette-pink-700)",
							link: "var(--palette-frost-700)",
							primaryBackground: "var(--paper)",
							primaryText: "var(--ink)",
							colorAccent: "var(--accent)",
							activeBorder: "var(--rule-strong)",
							tagBackground: "var(--palette-neutral-900)",
							tagText: "var(--palette-neutral-50)"
						},
						variables: {
							paper: "palette.neutral.50",
							ink: "palette.neutral.900",
							muted: "palette.neutral.600",
							faint: "palette.neutral.500",
							rule: "palette.neutral.300",
							"rule-strong": "palette.neutral.800",
							surface: "palette.neutral.100",
							sunk: "palette.neutral.200",
							accent: "palette.rose.700",
							"accent-ink": "palette.neutral.0",
							"accent-soft": "palette.rose.200",
							secondary: "palette.peri.700",
							tertiary: "palette.pink.700",
							link: "palette.frost.700"
						},
						settings: { variantNameOnly: true }
					}
				},
				settings: { selector: ".LightTheme" }
			},
			dark: {
				value: {
					colors: {
						value: {
							paper: "var(--palette-neutral-950)",
							ink: "var(--palette-neutral-50)",
							muted: "var(--palette-neutral-300)",
							faint: "var(--palette-neutral-400)",
							rule: "var(--palette-neutral-700)",
							"rule-strong": "var(--palette-neutral-400)",
							surface: "var(--palette-neutral-900)",
							sunk: "var(--palette-neutral-800)",
							accent: "var(--palette-aqua-300)",
							"accent-ink": "var(--palette-neutral-950)",
							"accent-soft": "var(--palette-aqua-800)",
							secondary: "var(--palette-peri-200)",
							tertiary: "var(--palette-pink-200)",
							link: "var(--palette-frost-200)",
							primaryBackground: "var(--paper)",
							primaryText: "var(--ink)",
							colorAccent: "var(--accent)",
							activeBorder: "var(--rule-strong)",
							tagBackground: "var(--palette-neutral-50)",
							tagText: "var(--palette-neutral-900)"
						},
						variables: {
							paper: "palette.neutral.950",
							ink: "palette.neutral.50",
							muted: "palette.neutral.300",
							faint: "palette.neutral.400",
							rule: "palette.neutral.700",
							"rule-strong": "palette.neutral.400",
							surface: "palette.neutral.900",
							sunk: "palette.neutral.800",
							accent: "palette.aqua.300",
							"accent-ink": "palette.neutral.950",
							"accent-soft": "palette.aqua.800",
							secondary: "palette.peri.200",
							tertiary: "palette.pink.200",
							link: "palette.frost.200"
						},
						settings: { variantNameOnly: true }
					}
				},
				settings: { selector: ".DarkTheme" }
			}
		}
	}
})
