% MiniZinc Example: N-Queens Problem
% This example demonstrates MiniZinc syntax highlighting

% Decision variable: queen positions
var 1..8: q1; var 1..8: q2; var 1..8: q3; var 1..8: q4;
var 1..8: q5; var 1..8: q6; var 1..8: q7; var 1..8: q8;

% All queens must be in different rows
constraint q1 != q2; constraint q1 != q3; constraint q1 != q4;
constraint q1 != q5; constraint q1 != q6; constraint q1 != q7;
constraint q1 != q8;

/* Block comment example:
   Diagonal constraints to ensure no two queens
   attack each other diagonally
*/
constraint q1 - q2 != 1 /\ q1 - q2 != -1;
constraint q1 - q3 != 2 /\ q1 - q3 != -2;

% Arrays and predicates
array[1..8] of var 1..8: queens;
predicate alldifferent_except_0(array[int] of var int: x);

% Constraint using forall
constraint forall(i,j in 1..8 where i < j) (
    queens[i] != queens[j] /\
    queens[i] + i != queens[j] + j /\
    queens[i] - i != queens[j] - j
);

% Solve statement with optimization
solve satisfy;
% solve minimize obj;
% solve maximize value;

% Output formatting
output ["Queens: ", show(queens), "\n"];

% Data types examples
int: n = 8;
float: pi = 3.14159;
bool: flag = true;
string: message = "Hello, MiniZinc!";
set of int: S = 1..10;

% Operators
var int: x = 5 + 3 * 2;
var bool: result = (x > 10) \/ (x <= 5);
var int: y = x div 2 mod 3;

% Functions and annotations
function var int: my_function(var int: a, var int: b) = a + b;
annotation my_annotation;

% Special keywords
enum Color = {Red, Green, Blue};
type MyType = int;
var opt int: optional_value;
par int: parameter = 42;

% Include directive
% include "globals.mzn";

% Test expressions
test my_test = x > 0;

% Let expression
var int: result2 = let {
    var int: temp = 10;
} in temp * 2;

% Case expression (if-then-else-endif)
var int: sign = if x > 0 then 1
                elseif x < 0 then -1
                else 0 endif;

% Set operations
set of int: A = 1..5;
set of int: B = 3..7;
set of int: C = A union B;
set of int: D = A intersect B;
set of int: E = A diff B;
set of int: F = A symdiff B;

% XOR operator
var bool: xor_result = true xor false;

% Range operator
array[1..10] of int: range_array = [i | i in 1..10];

% Tuple and record (newer MiniZinc features)
tuple(int, bool): my_tuple = (42, true);
record(int: field1, bool: field2): my_record;
