param([Parameter(Mandatory=$true)][string]$Exe, [Parameter(Mandatory=$true)][string]$Blob)
# Node SEA: write the blob into the PE resource named NODE_SEA_BLOB, type RT_RCDATA(10).
# (等价于 postject，但不引入第三方依赖；见 postject-api.h 里的 FindResourceA 调用)
# 保险丝（NODE_SEA_FUSE_...:0 -> :1）由 build.mjs 用 Node 改，那里快得多。
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SeaRes {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern IntPtr BeginUpdateResourceW(string file, bool del);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool UpdateResourceW(IntPtr h, IntPtr type, IntPtr name, ushort lang, byte[] data, uint size);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool EndUpdateResourceW(IntPtr h, bool discard);
}
'@
$data = [System.IO.File]::ReadAllBytes($Blob)
$h = [SeaRes]::BeginUpdateResourceW($Exe, $false)
if ($h -eq [IntPtr]::Zero) { throw ('BeginUpdateResource failed: ' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
$namePtr = [Runtime.InteropServices.Marshal]::StringToHGlobalUni('NODE_SEA_BLOB')
try {
  if (-not [SeaRes]::UpdateResourceW($h, [IntPtr]10, $namePtr, 0, $data, [uint32]$data.Length)) {
    throw ('UpdateResource failed: ' + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
  }
} finally {
  [Runtime.InteropServices.Marshal]::FreeHGlobal($namePtr)
}
if (-not [SeaRes]::EndUpdateResourceW($h, $false)) { throw 'EndUpdateResource failed' }
Write-Output ('sealed ' + $data.Length + ' bytes')
