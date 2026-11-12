' ============================================================
'  YangTex - Windows double-click launcher (no console window)
'  Double-click this file. It starts YangTex.py with pythonw.exe
'  in a fully hidden window; the browser opens by itself.
'  All strings are ASCII so this file works with any Windows locale.
' ============================================================
Option Explicit
Dim fso, sh, root, py, scriptPath
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = root
scriptPath = root & "\YangTex.py"

If Not fso.FileExists(scriptPath) Then
    MsgBox "YangTex.py was not found next to this launcher.", 16, "YangTex"
    WScript.Quit 1
End If

py = FindPython()
If py = "" Then
    MsgBox "Python 3 was not found." & vbCrLf & vbCrLf & _
           "Please install Python 3 and tick 'Add python.exe to PATH'," & vbCrLf & _
           "or edit FindPython() in this file to point to pythonw.exe.", _
           16, "YangTex"
    WScript.Quit 1
End If

' 0 = hidden window, False = do not wait. No black console stays on screen.
' --restart replaces an older instance so a double-click loads the newest code.
sh.Run """" & py & """ """ & scriptPath & """ --restart", 0, False

Function FindPython()
    Dim la, pf, c, i, p
    la = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%")
    pf = sh.ExpandEnvironmentStrings("%ProgramFiles%")
    c = Array( _
        la & "\Programs\Python\Python314\pythonw.exe", _
        la & "\Programs\Python\Python313\pythonw.exe", _
        la & "\Programs\Python\Python312\pythonw.exe", _
        la & "\Programs\Python\Python311\pythonw.exe", _
        la & "\Programs\Python\Python310\pythonw.exe", _
        "C:\Python314\pythonw.exe", "C:\Python313\pythonw.exe", _
        "C:\Python312\pythonw.exe", "C:\Python311\pythonw.exe", _
        "C:\Python310\pythonw.exe", _
        pf & "\Python313\pythonw.exe", pf & "\Python312\pythonw.exe", _
        root & "\pythonw.exe", "pythonw.exe", _
        la & "\Programs\Python\Python313\python.exe", _
        la & "\Programs\Python\Python312\python.exe", _
        "C:\Python313\python.exe", "python.exe" _
    )
    For i = 0 To UBound(c)
        p = c(i)
        If fso.FileExists(p) Then
            FindPython = p
            Exit Function
        End If
    Next
    ' Last resort: rely on PATH (Run with 0 still hides the console).
    FindPython = "pythonw.exe"
End Function
