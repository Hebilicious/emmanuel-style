import { defineConfig } from "@hebilicious/cssforge"

export default defineConfig({
	typography: {
		fluid: {
			content: {
				value: {
					minWidth: 320,
					minFontSize: 16,
					minTypeScale: 1.2,
					maxWidth: 1440,
					maxFontSize: 18,
					maxTypeScale: 1.25,
					positiveSteps: 5,
					negativeSteps: 2
				}
			}
		}
	},
	colors: {
		palette: {
			value: {
				basic: {
					black: { hex: "#000000" },
					white: { hex: "#ffffff" },
					darkTheme: { hex: "#1b1c31" },
					grey: { hex: "#c6c6c6" },
					beige: { hex: "#fdfaf5" },
					darkBeige: { hex: "#fef1e0" },
					golden: { hex: "#ffe5c4" },
					lightPink: { hex: "#f4bed8" },
					vividPink: { hex: "#ff8dd5" },
					darkPink: { hex: "#ff7699" },
					ultraMarine: { hex: "#7887fe" },
					lightBlue: { hex: "#21bffe" },
					indigo: { hex: "#b2f2e4" },
					lightGreen: { hex: "#91d7d9" },
					green: { hex: "#6dd5be" }
				}
			}
		},
		gradients: {
			value: {
				pink: {
					value: {
						primary: {
							value: "linear-gradient(28deg, var(--c1) 0%, var(--c2) 50%, var(--c3) 100%)",
							variables: {
								c1: "palette.value.basic.darkBeige",
								c2: "palette.value.basic.lightPink",
								c3: "palette.value.basic.indigo"
							}
						}
					}
				}
			}
		},
		theme: {
			value: {
				all: {
					pink: {
						value: {
							primaryBackground: "var(--gradient)",
							navbarColor: "var(--navbar)",
							primaryText: "var(--text)",
							giantText: "var(--giant)",
							colorAccent: "var(--accent)",
							secondaryAccent: "var(--secondary)",
							activeBorder: "var(--border)",
							tagBackground: "oklch(45% 0.15 180)",
							tagText: "oklch(95% 0.02 180)"
						},
						variables: {
							gradient: "gradients.value.pink.primary",
							navbar: "palette.value.basic.indigo",
							text: "palette.value.basic.black",
							giant: "palette.value.basic.beige",
							accent: "palette.value.basic.black",
							secondary: "palette.value.basic.grey",
							border: "palette.value.basic.lightGreen"
						}
					},
					paper: {
						value: {
							primaryBackground: "var(--bg)",
							navbarColor: "var(--navbar)",
							primaryText: "var(--text)",
							colorAccent: "var(--accent)",
							secondaryAccent: "var(--secondary)",
							activeBorder: "var(--border)",
							tagBackground: "oklch(40% 0.12 320)",
							tagText: "oklch(98% 0.01 320)"
						},
						variables: {
							bg: "palette.value.basic.beige",
							navbar: "palette.value.basic.beige",
							text: "palette.value.basic.black",
							accent: "palette.value.basic.grey",
							secondary: "palette.value.basic.grey",
							border: "palette.value.basic.lightPink"
						}
					},
					light: {
						value: {
							primaryBackground: "var(--bg)",
							navbarColor: "var(--navbar)",
							primaryText: "var(--text)",
							colorAccent: "var(--accent)",
							secondaryAccent: "var(--secondary)",
							activeBorder: "var(--border)",
							tagBackground: "oklch(35% 0.08 260)",
							tagText: "oklch(98% 0.01 260)"
						},
						variables: {
							bg: "palette.value.basic.white",
							navbar: "palette.value.basic.white",
							text: "palette.value.basic.black",
							accent: "palette.value.basic.darkTheme",
							secondary: "palette.value.basic.grey",
							border: "palette.value.basic.darkTheme"
						}
					},
					dark: {
						value: {
							primaryBackground: "var(--bg)",
							navbarColor: "var(--navbar)",
							primaryText: "var(--text)",
							colorAccent: "var(--accent)",
							secondaryAccent: "var(--secondary)",
							activeBorder: "var(--border)",
							tagBackground: "oklch(65% 0.15 170)",
							tagText: "oklch(20% 0.05 170)"
						},
						variables: {
							bg: "palette.value.basic.darkTheme",
							navbar: "palette.value.basic.darkTheme",
							text: "palette.value.basic.white",
							accent: "palette.value.basic.darkPink",
							secondary: "palette.value.basic.grey",
							border: "palette.value.basic.lightGreen"
						}
					}
				}
			}
		}
	}
})
