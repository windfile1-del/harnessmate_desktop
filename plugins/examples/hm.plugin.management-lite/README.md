# External Management Lite

Runnable ordinary replacement for `management.view.v1`. Its backend provides the service and `ui/module.mjs` uses W1 transport/navigation/kernel APIs. No official plugin IDs, private stores or registry imports. UI supports listing instances, binding, digest-reviewed first-source install, enable/disable, previous revision and previous composition.

After `pnpm build`, start HarnessMate normally and preview/install this directory using the current manager or the independent `#kernel-recovery` page. Review and trust the code. Bind `management.view.v1` to `user.management-lite`; the default shell's plugin-center action resolves this binding and opens page `manage`.

Equivalent local PowerShell commands (use the actual listening port):

```powershell
$base = 'http://127.0.0.1:4789/api/v1'
$source = 'D:/HarnessMate/b5-w2-management/plugins/examples/hm.plugin.management-lite'
$review = Invoke-RestMethod "$base/plugins/preview" -Method Post -ContentType application/json -Body (@{mode='local_dir';dirPath=$source} | ConvertTo-Json)
$review | ConvertTo-Json -Depth 8 # review source, permissions and digest before trust
Invoke-RestMethod "$base/plugins/install" -Method Post -ContentType application/json -Body (@{mode='local_dir';dirPath=$source;expectedDigest=$review.digest;expectedInstalledDigest=$review.installedDigest;trustCode=$true} | ConvertTo-Json)
Invoke-RestMethod "$base/plugins/composition/bindings" -Method Put -ContentType application/json -Body (@{contract='management.view.v1';instanceId='user.management-lite'} | ConvertTo-Json)
```

To demonstrate a second revision, copy the source to a D-drive development directory, change version/UI, preview then install the updated package with its current installed digest. The previous-revision button becomes available. An `apply` failure does not commit the bad revision. To recover after self-disable use `#kernel-recovery` to enable or roll back; that view remains independent of this package and the default manager. Composition restore and revision rollback are separate operations and do not erase plugin data.
