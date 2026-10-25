; Simple Scheme test examples

; Basic arithmetic
(display "Testing basic arithmetic:")
(newline)
(display (+ 2 3))
(newline)
(display (* 4 5))
(newline)

; Lists and recursion
(display "Testing lists:")
(newline)
(define my-list '(1 2 3 4 5))
(display my-list)
(newline)
(display (car my-list))
(newline)
(display (cdr my-list))
(newline)

; Factorial function
(define (factorial n)
  (if (<= n 1)
      1
      (* n (factorial (- n 1)))))

(display "Factorial of 5:")
(newline)
(display (factorial 5))
(newline)

; Map function
(display "Mapping square over list:")
(newline)
(define (square x) (* x x))
(display (map square '(1 2 3 4 5)))
(newline)
