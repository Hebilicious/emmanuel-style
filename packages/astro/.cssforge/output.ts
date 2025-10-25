export const cssForge = {
  "palette": {
    "value": {
      "basic": {
        "black": {
          "key": "--palette-basic-black",
          "value": "oklch(0% 0 0)",
          "variable": "--palette-basic-black: oklch(0% 0 0);"
        },
        "white": {
          "key": "--palette-basic-white",
          "value": "oklch(100% 0 0)",
          "variable": "--palette-basic-white: oklch(100% 0 0);"
        },
        "darkTheme": {
          "key": "--palette-basic-darkTheme",
          "value": "oklch(23.653% 0.04014 280.77419)",
          "variable": "--palette-basic-darkTheme: oklch(23.653% 0.04014 280.77419);"
        },
        "grey": {
          "key": "--palette-basic-grey",
          "value": "oklch(82.656% 0 0)",
          "variable": "--palette-basic-grey: oklch(82.656% 0 0);"
        },
        "beige": {
          "key": "--palette-basic-beige",
          "value": "oklch(98.602% 0.00735 80.72128)",
          "variable": "--palette-basic-beige: oklch(98.602% 0.00735 80.72128);"
        },
        "darkBeige": {
          "key": "--palette-basic-darkBeige",
          "value": "oklch(96.385% 0.02649 74.76356)",
          "variable": "--palette-basic-darkBeige: oklch(96.385% 0.02649 74.76356);"
        },
        "golden": {
          "key": "--palette-basic-golden",
          "value": "oklch(93.478% 0.05182 73.69061)",
          "variable": "--palette-basic-golden: oklch(93.478% 0.05182 73.69061);"
        },
        "lightPink": {
          "key": "--palette-basic-lightPink",
          "value": "oklch(85.717% 0.0701 348.17828)",
          "variable": "--palette-basic-lightPink: oklch(85.717% 0.0701 348.17828);"
        },
        "vividPink": {
          "key": "--palette-basic-vividPink",
          "value": "oklch(78.774% 0.16073 342.86255)",
          "variable": "--palette-basic-vividPink: oklch(78.774% 0.16073 342.86255);"
        },
        "darkPink": {
          "key": "--palette-basic-darkPink",
          "value": "oklch(73.647% 0.16933 6.15278)",
          "variable": "--palette-basic-darkPink: oklch(73.647% 0.16933 6.15278);"
        },
        "ultraMarine": {
          "key": "--palette-basic-ultraMarine",
          "value": "oklch(66.819% 0.17496 275.22226)",
          "variable": "--palette-basic-ultraMarine: oklch(66.819% 0.17496 275.22226);"
        },
        "lightBlue": {
          "key": "--palette-basic-lightBlue",
          "value": "oklch(75.721% 0.14894 232.30146)",
          "variable": "--palette-basic-lightBlue: oklch(75.721% 0.14894 232.30146);"
        },
        "indigo": {
          "key": "--palette-basic-indigo",
          "value": "oklch(91.427% 0.06709 179.69384)",
          "variable": "--palette-basic-indigo: oklch(91.427% 0.06709 179.69384);"
        },
        "lightGreen": {
          "key": "--palette-basic-lightGreen",
          "value": "oklch(83.364% 0.07008 198.16877)",
          "variable": "--palette-basic-lightGreen: oklch(83.364% 0.07008 198.16877);"
        },
        "green": {
          "key": "--palette-basic-green",
          "value": "oklch(80.407% 0.10327 177.24406)",
          "variable": "--palette-basic-green: oklch(80.407% 0.10327 177.24406);"
        }
      }
    }
  },
  "gradients": {
    "value": {
      "pink": {
        "primary": {
          "variable": "--gradients-pink-primary: linear-gradient(28deg, var(--palette-basic-darkBeige) 0%, var(--palette-basic-lightPink) 50%, var(--palette-basic-indigo) 100%);",
          "key": "--gradients-pink-primary",
          "value": "linear-gradient(28deg, var(--palette-basic-darkBeige) 0%, var(--palette-basic-lightPink) 50%, var(--palette-basic-indigo) 100%)"
        }
      }
    }
  },
  "theme": {
    "value": {
      "all": {
        "pink": {
          "primaryBackground": {
            "key": "--theme-all-pink-primaryBackground",
            "value": "var(--gradients-pink-primary)",
            "variable": "--theme-all-pink-primaryBackground: var(--gradients-pink-primary);"
          },
          "navbarColor": {
            "key": "--theme-all-pink-navbarColor",
            "value": "var(--palette-basic-indigo)",
            "variable": "--theme-all-pink-navbarColor: var(--palette-basic-indigo);"
          },
          "primaryText": {
            "key": "--theme-all-pink-primaryText",
            "value": "var(--palette-basic-black)",
            "variable": "--theme-all-pink-primaryText: var(--palette-basic-black);"
          },
          "giantText": {
            "key": "--theme-all-pink-giantText",
            "value": "var(--palette-basic-beige)",
            "variable": "--theme-all-pink-giantText: var(--palette-basic-beige);"
          },
          "colorAccent": {
            "key": "--theme-all-pink-colorAccent",
            "value": "var(--palette-basic-black)",
            "variable": "--theme-all-pink-colorAccent: var(--palette-basic-black);"
          },
          "secondaryAccent": {
            "key": "--theme-all-pink-secondaryAccent",
            "value": "var(--palette-basic-grey)",
            "variable": "--theme-all-pink-secondaryAccent: var(--palette-basic-grey);"
          },
          "activeBorder": {
            "key": "--theme-all-pink-activeBorder",
            "value": "var(--palette-basic-lightGreen)",
            "variable": "--theme-all-pink-activeBorder: var(--palette-basic-lightGreen);"
          },
          "tagBackground": {
            "key": "--theme-all-pink-tagBackground",
            "value": "oklch(45% 0.15 180)",
            "variable": "--theme-all-pink-tagBackground: oklch(45% 0.15 180);"
          },
          "tagText": {
            "key": "--theme-all-pink-tagText",
            "value": "oklch(95% 0.02 180)",
            "variable": "--theme-all-pink-tagText: oklch(95% 0.02 180);"
          }
        },
        "paper": {
          "primaryBackground": {
            "key": "--theme-all-paper-primaryBackground",
            "value": "var(--palette-basic-beige)",
            "variable": "--theme-all-paper-primaryBackground: var(--palette-basic-beige);"
          },
          "navbarColor": {
            "key": "--theme-all-paper-navbarColor",
            "value": "var(--palette-basic-beige)",
            "variable": "--theme-all-paper-navbarColor: var(--palette-basic-beige);"
          },
          "primaryText": {
            "key": "--theme-all-paper-primaryText",
            "value": "var(--palette-basic-black)",
            "variable": "--theme-all-paper-primaryText: var(--palette-basic-black);"
          },
          "colorAccent": {
            "key": "--theme-all-paper-colorAccent",
            "value": "var(--palette-basic-grey)",
            "variable": "--theme-all-paper-colorAccent: var(--palette-basic-grey);"
          },
          "secondaryAccent": {
            "key": "--theme-all-paper-secondaryAccent",
            "value": "var(--palette-basic-grey)",
            "variable": "--theme-all-paper-secondaryAccent: var(--palette-basic-grey);"
          },
          "activeBorder": {
            "key": "--theme-all-paper-activeBorder",
            "value": "var(--palette-basic-lightPink)",
            "variable": "--theme-all-paper-activeBorder: var(--palette-basic-lightPink);"
          },
          "tagBackground": {
            "key": "--theme-all-paper-tagBackground",
            "value": "oklch(40% 0.12 320)",
            "variable": "--theme-all-paper-tagBackground: oklch(40% 0.12 320);"
          },
          "tagText": {
            "key": "--theme-all-paper-tagText",
            "value": "oklch(98% 0.01 320)",
            "variable": "--theme-all-paper-tagText: oklch(98% 0.01 320);"
          }
        },
        "light": {
          "primaryBackground": {
            "key": "--theme-all-light-primaryBackground",
            "value": "var(--palette-basic-white)",
            "variable": "--theme-all-light-primaryBackground: var(--palette-basic-white);"
          },
          "navbarColor": {
            "key": "--theme-all-light-navbarColor",
            "value": "var(--palette-basic-white)",
            "variable": "--theme-all-light-navbarColor: var(--palette-basic-white);"
          },
          "primaryText": {
            "key": "--theme-all-light-primaryText",
            "value": "var(--palette-basic-black)",
            "variable": "--theme-all-light-primaryText: var(--palette-basic-black);"
          },
          "colorAccent": {
            "key": "--theme-all-light-colorAccent",
            "value": "var(--palette-basic-darkTheme)",
            "variable": "--theme-all-light-colorAccent: var(--palette-basic-darkTheme);"
          },
          "secondaryAccent": {
            "key": "--theme-all-light-secondaryAccent",
            "value": "var(--palette-basic-grey)",
            "variable": "--theme-all-light-secondaryAccent: var(--palette-basic-grey);"
          },
          "activeBorder": {
            "key": "--theme-all-light-activeBorder",
            "value": "var(--palette-basic-darkTheme)",
            "variable": "--theme-all-light-activeBorder: var(--palette-basic-darkTheme);"
          },
          "tagBackground": {
            "key": "--theme-all-light-tagBackground",
            "value": "oklch(35% 0.08 260)",
            "variable": "--theme-all-light-tagBackground: oklch(35% 0.08 260);"
          },
          "tagText": {
            "key": "--theme-all-light-tagText",
            "value": "oklch(98% 0.01 260)",
            "variable": "--theme-all-light-tagText: oklch(98% 0.01 260);"
          }
        },
        "dark": {
          "primaryBackground": {
            "key": "--theme-all-dark-primaryBackground",
            "value": "var(--palette-basic-darkTheme)",
            "variable": "--theme-all-dark-primaryBackground: var(--palette-basic-darkTheme);"
          },
          "navbarColor": {
            "key": "--theme-all-dark-navbarColor",
            "value": "var(--palette-basic-darkTheme)",
            "variable": "--theme-all-dark-navbarColor: var(--palette-basic-darkTheme);"
          },
          "primaryText": {
            "key": "--theme-all-dark-primaryText",
            "value": "var(--palette-basic-white)",
            "variable": "--theme-all-dark-primaryText: var(--palette-basic-white);"
          },
          "colorAccent": {
            "key": "--theme-all-dark-colorAccent",
            "value": "var(--palette-basic-darkPink)",
            "variable": "--theme-all-dark-colorAccent: var(--palette-basic-darkPink);"
          },
          "secondaryAccent": {
            "key": "--theme-all-dark-secondaryAccent",
            "value": "var(--palette-basic-grey)",
            "variable": "--theme-all-dark-secondaryAccent: var(--palette-basic-grey);"
          },
          "activeBorder": {
            "key": "--theme-all-dark-activeBorder",
            "value": "var(--palette-basic-lightGreen)",
            "variable": "--theme-all-dark-activeBorder: var(--palette-basic-lightGreen);"
          },
          "tagBackground": {
            "key": "--theme-all-dark-tagBackground",
            "value": "oklch(65% 0.15 170)",
            "variable": "--theme-all-dark-tagBackground: oklch(65% 0.15 170);"
          },
          "tagText": {
            "key": "--theme-all-dark-tagText",
            "value": "oklch(20% 0.05 170)",
            "variable": "--theme-all-dark-tagText: oklch(20% 0.05 170);"
          }
        }
      }
    }
  },
  "typography_fluid": {
    "content@4xl": {
      "variable": "--typography_fluid-content-4xl: clamp(2.4883rem, 2.2183rem + 1.3499vw, 3.4332rem);",
      "key": "--typography_fluid-content-4xl",
      "value": "clamp(2.4883rem, 2.2183rem + 1.3499vw, 3.4332rem)"
    },
    "content@3xl": {
      "variable": "--typography_fluid-content-3xl: clamp(2.0736rem, 1.8813rem + 0.9614vw, 2.7466rem);",
      "key": "--typography_fluid-content-3xl",
      "value": "clamp(2.0736rem, 1.8813rem + 0.9614vw, 2.7466rem)"
    },
    "content@2xl": {
      "variable": "--typography_fluid-content-2xl: clamp(1.728rem, 1.5939rem + 0.6704vw, 2.1973rem);",
      "key": "--typography_fluid-content-2xl",
      "value": "clamp(1.728rem, 1.5939rem + 0.6704vw, 2.1973rem)"
    },
    "content@xl": {
      "variable": "--typography_fluid-content-xl: clamp(1.44rem, 1.3492rem + 0.454vw, 1.7578rem);",
      "key": "--typography_fluid-content-xl",
      "value": "clamp(1.44rem, 1.3492rem + 0.454vw, 1.7578rem)"
    },
    "content@l": {
      "variable": "--typography_fluid-content-l: clamp(1.2rem, 1.1411rem + 0.2946vw, 1.4063rem);",
      "key": "--typography_fluid-content-l",
      "value": "clamp(1.2rem, 1.1411rem + 0.2946vw, 1.4063rem)"
    },
    "content@m": {
      "variable": "--typography_fluid-content-m: clamp(1rem, 0.9643rem + 0.1786vw, 1.125rem);",
      "key": "--typography_fluid-content-m",
      "value": "clamp(1rem, 0.9643rem + 0.1786vw, 1.125rem)"
    },
    "content@s": {
      "variable": "--typography_fluid-content-s: clamp(0.8333rem, 0.8143rem + 0.0952vw, 0.9rem);",
      "key": "--typography_fluid-content-s",
      "value": "clamp(0.8333rem, 0.8143rem + 0.0952vw, 0.9rem)"
    },
    "content@xs": {
      "variable": "--typography_fluid-content-xs: clamp(0.6944rem, 0.6871rem + 0.0365vw, 0.72rem);",
      "key": "--typography_fluid-content-xs",
      "value": "clamp(0.6944rem, 0.6871rem + 0.0365vw, 0.72rem)"
    }
  }
} as const;