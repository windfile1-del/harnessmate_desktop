const bridge = window.harnessMate;
const view = document.querySelector('#info');
const render = (session, props) => {
  view.textContent = ['W2 会话夹具', bridge.slotId, session?.id, props.itemId ?? props.groupId].filter(Boolean).join(' · ');
};
render(bridge.session, bridge.props);
bridge.onContext(render);
bridge.resize(52);
