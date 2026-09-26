/** Same React instance as the host. Hooks in this panel must use host.React. */
export function register(host) {
  const React = host.React;
  const h = React.createElement;
  window.__CFD_SINGLE_REACT__ = host.React === window.__CFD_REACT__;
  host.pluginUi.registerPanel({
    key: 'example-hook-monitor',
    title: 'Hook monitor (demo)',
    place: 'prefs',
    Component() {
      const [open, setOpen] = React.useState(false);
      return h(
        'span',
        { className: 'hook-monitor-demo' },
        h(
          'button',
          {
            type: 'button',
            className: 'home-btn',
            'data-plugin-hook': '1',
            'aria-expanded': open ? 'true' : 'false',
            title: "Explains this plugin's case.written hook. Demo only.",
            onClick() {
              setOpen((value) => !value);
            },
          },
          open ? 'Hide hook details' : 'What does this hook do?',
        ),
        open
          ? h(
              'p',
              { 'data-plugin-hook-detail': '1' },
              'Demo only. Each time Magnusim writes a case, this plugin’s case.written hook adds an ' +
                'exampleHookMonitor function object to system/controlDict. During the solve it writes the ' +
                'area-averaged pressure on the walls patch to postProcessing/exampleHookMonitor every time step.',
            )
          : null,
      );
    },
  });
}
