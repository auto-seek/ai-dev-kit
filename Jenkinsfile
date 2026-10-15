pipeline {
  agent any

  options {
    disableConcurrentBuilds(abortPrevious: true)
    timestamps()
  }

  stages {
    stage('Checkout') {
      steps {
        checkout([
          $class: 'GitSCM',
          branches: [[name: env.GIT_BUILD_REF]],
          userRemoteConfigs: [[
            url: env.GIT_REPO_URL,
            credentialsId: env.CREDENTIALS_ID
          ]]
        ])
      }
    }

    stage('Version contract') {
      steps {
        sh '''
          test "$(node -p "require('./package.json').version")" = "$(node -p "require('./.claude-plugin/plugin.json').version")"
          test "$(node -p "require('./package.json').version")" = "$(node -p "require('./.claude-plugin/marketplace.json').metadata.version")"
          test "$(node -p "require('./package.json').version")" = "$(node -p "require('./.claude-plugin/marketplace.json').plugins[0].version")"
        '''
      }
    }

    stage('Test and build') {
      steps {
        sh 'npm test'
        sh 'npm run build'
      }
    }

    stage('Skill schema') {
      steps {
        sh '''
          python3 -m venv .ci-skill-validator
          . .ci-skill-validator/bin/activate
          python -m pip install --disable-pip-version-check --no-cache-dir 'PyYAML==6.0.2'
          for d in skills/*; do
            python scripts/quick-validate-skill.py "$d"
          done
        '''
      }
    }

    stage('Real Redis lease') {
      steps {
        sh '''
          docker run --rm -v "$PWD:/work" -w /work python:3.12-alpine sh -ec '
            apk add --no-cache bash redis >/dev/null
            pip install --no-cache-dir -q redis
            bash tests/lease-redis-test.sh
          '
        '''
      }
    }

    stage('Package') {
      steps {
        sh 'npm pack --dry-run'
      }
    }
  }
}
