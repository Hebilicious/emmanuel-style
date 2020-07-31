module.exports = {
    extends: ["stylelint-config-standard", "stylelint-config-prettier"],
    // add your custom config here
    // https://stylelint.io/user-guide/configuration
    rules: {
        "color-hex-length": "long",
        "at-rule-no-unknown": [
            true,
            {
                ignoreAtRules: ["tailwind", "apply", "variants", "responsive", "screen"]
            }
        ]
    }
}
