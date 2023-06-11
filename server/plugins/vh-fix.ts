const vhFixScript = /* ts */ `<script>
// This should fix the vh bugs
const customViewportCorrectionVariable = "vh"

function setViewportProperty(doc) {
    let prevClientHeight
    const customVar = "--" + (customViewportCorrectionVariable || "vh")
    function handleResize() {
        const clientHeight = doc.clientHeight
        if (clientHeight === prevClientHeight) return
        requestAnimationFrame(function updateViewportHeight() {
            doc.style.setProperty(customVar, clientHeight * 0.01 + "px")
            prevClientHeight = clientHeight
        })
    }
    handleResize()
    return handleResize
}
window.addEventListener("resize", setViewportProperty(document.documentElement))
</script>` as const

export default defineNitroPlugin((nitro) => {
    nitro.hooks.hook("render:html", (html) => {
        html.head.push(vhFixScript)
    })
})
