; AutoLISP Drawing Example
; This demonstrates basic CAD drawing with the acadlisp interpreter

; Draw a simple house shape

; Define the base rectangle (walls)
(command "LINE" '(0 0) '(100 0) "")      ; Bottom wall
(command "LINE" '(100 0) '(100 60) "")   ; Right wall
(command "LINE" '(100 60) '(0 60) "")    ; Top wall
(command "LINE" '(0 60) '(0 0) "")       ; Left wall

; Draw the roof (triangle)
(command "LINE" '(0 60) '(50 100) "")    ; Left roof slope
(command "LINE" '(50 100) '(100 60) "")  ; Right roof slope

; Draw a door
(command "LINE" '(40 0) '(40 30) "")     ; Left side of door
(command "LINE" '(40 30) '(60 30) "")    ; Top of door
(command "LINE" '(60 30) '(60 0) "")     ; Right side of door

; Draw a window (left side)
(command "LINE" '(10 35) '(30 35) "")    ; Bottom
(command "LINE" '(30 35) '(30 50) "")    ; Right
(command "LINE" '(30 50) '(10 50) "")    ; Top
(command "LINE" '(10 50) '(10 35) "")    ; Left

; Draw a window (right side)
(command "LINE" '(70 35) '(90 35) "")    ; Bottom
(command "LINE" '(90 35) '(90 50) "")    ; Right
(command "LINE" '(90 50) '(70 50) "")    ; Top
(command "LINE" '(70 50) '(70 35) "")    ; Left

; Draw a circle for the sun
(command "CIRCLE" '(120 90) 15 "")

; Print a message
(princ "House drawing complete!")
