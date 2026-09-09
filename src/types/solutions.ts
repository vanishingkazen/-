export interface Solution {
  initial_thoughts: string[]
  thought_steps: string[]
  description: string
  basic_code?: string
  code: string
}

export interface SolutionsResponse {
  [key: string]: Solution
}

export interface ProblemStatementData {
  problem_statement: string
  constraints?: string
  example_input?: string
  example_output?: string
  starter_code?: string
  required_signature?: string
  input_format: {
    description: string
    parameters: any[]
  }
  output_format: {
    description: string
    type: string
    subtype: string
  }
  complexity: {
    time: string
    space: string
  }
  test_cases: any[]
  validation_type: string
  difficulty: string
}
