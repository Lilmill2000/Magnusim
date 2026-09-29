/** Loads only if the host serves UI files from the folder, not from the manifest key. */
export function register(host) {
  const h = host.React.createElement;
  host.pluginUi.registerPanel({
    key: 'key-not-folder',
    title: 'Key differs from folder',
    place: 'prefs',
    Component() {
      return h('span', { 'data-plugin-keyfolder': '1' }, 'UI loaded from the plugin folder.');
    },
  });
}
