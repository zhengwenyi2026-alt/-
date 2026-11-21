; Windows 安装时直接放行防火墙，避免首次建房时 UDP 发现被拦。
; runas 会弹一次 UAC；用户取消也不影响安装，届时 Windows 会在应用首次监听时再弹一次放行询问。
!macro customInstall
  ExecShellWait "runas" "netsh" `advfirewall firewall add rule name="SkyDrop 隔空传" dir=in action=allow enable=yes profile=any program="$INSTDIR\隔空传.exe"` SW_HIDE
  ExecShellWait "runas" "netsh" `advfirewall firewall add rule name="SkyDrop 隔空传" dir=out action=allow enable=yes profile=any program="$INSTDIR\隔空传.exe"` SW_HIDE
!macroend

!macro customUnInstall
  ExecShellWait "runas" "netsh" `advfirewall firewall delete rule name="SkyDrop 隔空传"` SW_HIDE
!macroend
