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
					value: {
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
			}
		},
		gradients: {
			value: {
				pink: {
					value: {
						primary: {
							value: "linear-gradient(28deg, var(--c1) 0%, var(--c2) 50%, var(--c3) 100%)",
							variables: {
								c1: "palette.basic.darkBeige",
								c2: "palette.basic.lightPink",
								c3: "palette.basic.indigo"
							}
						}
					}
				}
			}
		},
		theme: {
			dark: {
				value: {
					colors: {
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
							bg: "palette.basic.darkTheme",
							navbar: "palette.basic.darkTheme",
							text: "palette.basic.white",
							accent: "palette.basic.darkPink",
							secondary: "palette.basic.grey",
							border: "palette.basic.lightGreen"
						},
						settings: {
							variantNameOnly: true
						}
					}
				},
				settings: {
					selector: ".DarkTheme"
				}
			},
			light: {
				value: {
					colors: {
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
							bg: "palette.basic.white",
							navbar: "palette.basic.white",
							text: "palette.basic.black",
							accent: "palette.basic.darkTheme",
							secondary: "palette.basic.grey",
							border: "palette.basic.darkTheme"
						},
						settings: {
							variantNameOnly: true
						}
					}
				},
				settings: {
					selector: ".LightTheme"
				}
			},
			paper: {
				value: {
					colors: {
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
							bg: "palette.basic.beige",
							navbar: "palette.basic.beige",
							text: "palette.basic.black",
							accent: "palette.basic.grey",
							secondary: "palette.basic.grey",
							border: "palette.basic.lightPink"
						},
						settings: {
							variantNameOnly: true
						}
					}
				},
				settings: {
					selector: ".PaperTheme"
				}
			},
			pink: {
				value: {
					colors: {
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
							gradient: "gradients.pink.primary",
							navbar: "palette.basic.indigo",
							text: "palette.basic.black",
							giant: "palette.basic.beige",
							accent: "palette.basic.black",
							secondary: "palette.basic.grey",
							border: "palette.basic.lightGreen"
						},
						settings: {
							variantNameOnly: true
						}
					}
				},
				settings: {
					selector: ".PinkTheme"
				}
			}
		}
	}
})
